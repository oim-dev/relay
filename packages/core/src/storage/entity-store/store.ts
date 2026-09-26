import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  storageManifestSchema,
  storedKeySpaceSchema,
  storageCardSchema,
  storedReceiptSchema,
  storedCommentSchema,
  storedPlanningEventSchema,
} from "@relay/contracts/storage";
import type {
  JsonValue,
  StoredRecord,
  StorageCard,
  StoredKeySpace,
} from "@relay/contracts/storage";
import { entityAddress, entityRefSchema } from "@relay/contracts/entities/graph";
import type { EntityRef } from "@relay/contracts/entities/graph";
import { actorSchema, requestIdSchema, entityReferenceSchema } from "@relay/contracts/primitives";
import { AppError, invariant } from "../../shared/errors.js";
import { exists, readJson, jsonFiles, directories, syncDirectory } from "../files.js";
import { withStorageLock } from "../lock.js";
import { StorageTransaction } from "./transaction.js";
import type { TransactionProbe } from "./transaction.js";
import { HashIndex, forgetStorageSegments } from "./hash-index.js";
import { EntityStorageRegistry } from "./registry.js";
import type { EntityRecord } from "./registry.js";
import { STATE_PATH, EMPTY_STATE, stateSchema, RECORD_BYTES, digest, jsonValue } from "./format.js";
import type { StoreState, FileChange } from "./format.js";
import { storageMigrationOptionsSchema, verifyAppliedOrphanPlanningApproval } from "../migration/orphan-planning-approval.js";
import type { StorageMigrationOptions } from "../migration/orphan-planning-approval.js";
const receiptKey = (command: Pick<StorageCommand, "namespace" | "actor" | "requestId">) =>
  JSON.stringify([command.namespace, command.actor, command.requestId]);

const candidateSchema = z.strictObject({
  ref: entityRefSchema,
  matches: z.array(z.enum(["id", "key", "alias"])),
  deleted: z.boolean(),
});
type Candidate = z.infer<typeof candidateSchema>;
const candidatesSchema = z.array(candidateSchema);
const postingIdsSchema = z.array(z.string());
const postingPointerSchema = z.strictObject({ root: z.string() });
const postingValueSchema = z.union([postingIdsSchema, postingPointerSchema]);
const taskReceiptPointerSchema = z.strictObject({
  owner: entityRefSchema,
  identity: z.string(),
  kind: z.enum(["task", "comment"]),
  form: z.enum(["native", "compatible"]),
});
type TaskReceiptPointer = z.infer<typeof taskReceiptPointerSchema>;
const taskRequestKey = (actor: string, requestId: string) =>
  createHash("sha256").update(JSON.stringify([actor, requestId])).digest("hex");

function taskReceiptScope(owner: EntityRef, receipt: z.output<typeof storedReceiptSchema>): { key: string; pointer: TaskReceiptPointer } | undefined {
  if (receipt.namespace === "board-task" || receipt.namespace === "task-comment")
    return { key: taskRequestKey(receipt.actor, receipt.requestId), pointer: {
      owner, identity: receiptKey(receipt), kind: receipt.namespace === "board-task" ? "task" as const : "comment" as const,
      form: "native" as const,
    } };
  const kind = receipt.namespace.startsWith("legacy:record:task:") ? "task"
    : receipt.namespace === "legacy:task-comment-receipt" ? "comment" : undefined;
  if (!kind) return undefined;
  const value = z.object({ key: z.string(), value: z.json() }).parse(receipt.result);
  return { key: value.key, pointer: { owner, identity: receiptKey(receipt), kind, form: "compatible" as const } };
}

function mergeTaskReceipt(before: TaskReceiptPointer | undefined, after: TaskReceiptPointer) {
  invariant(!before || (sameRef(before.owner, after.owner) && before.kind === after.kind),
    "IDEMPOTENCY_CONFLICT", "Ключ запроса уже занят в общей области задач и комментариев", 4);
  invariant(!before || before.form !== after.form || before.identity === after.identity,
    "IDEMPOTENCY_CONFLICT", "Один ключ области задач указывает на разные квитанции", 4);
  return before?.form === "compatible" ? before : after;
}
const commandSchema = z.strictObject({
  namespace: z.string().min(1).max(128),
  actor: actorSchema,
  requestId: requestIdSchema,
  request: z.json(),
});
export type StorageCommand = z.infer<typeof commandSchema>;
const sameRef = (a: EntityRef, b: EntityRef) => a.kind === b.kind && a.id === b.id;
const refOf = (record: StoredRecord) => ({ kind: record.kind, id: record.id });

/** Низкоуровневый владелец одной базы. Предметные сценарии вызывают run после своих проверок. */
export class EntityStore {
  formatVersion: 1 | 2 | 3 = 3;
  readonly metrics = {
    entityReads: 0,
    operationReads: 0,
    relationReads: 0,
    directoryReads: 0,
    indexReads: 0,
  };
  private constructor(
    readonly root: string,
    readonly registry: EntityStorageRegistry,
    readonly probe?: TransactionProbe,
  ) {}

  static async create(path: string, registry: EntityStorageRegistry): Promise<EntityStore> {
    const absolute = resolve(path);
    const first = await mkdir(absolute, { recursive: true });
    if (first) {
      let current = absolute;
      while (true) {
        await syncDirectory(current);
        if (current === dirname(first)) break;
        current = dirname(current);
      }
    }
    const store = new EntityStore(await realpath(path), registry);
    const transaction = new StorageTransaction(store.root);
    await transaction.prepareDirectories();
    await withStorageLock(
      store.root,
      async (owned) => {
        await transaction.recover(owned);
        invariant(
          !(await exists(join(store.root, "storage.json"))),
          "STORAGE_ALREADY_INITIALIZED",
          "Единое хранилище уже инициализировано",
          4,
        );
        const entries = await readdir(store.root);
        invariant(
          entries.every((name) =>
            ["config.json", "runtime", "transactions", ".indexes"].includes(name),
          ),
          "STORAGE_MIGRATION_REQUIRED",
          "В каталоге есть прежние данные. Требуется явная миграция",
          4,
        );
        await transaction.publish(
          [
            { path: STATE_PATH, after: { ...EMPTY_STATE, version: randomUUID() } },
            { path: "storage.json", after: { format: "relay-entities", schemaVersion: 3 } },
          ],
          owned,
        );
      },
      transaction.runtime,
    );
    return store;
  }

  static async open(
    path: string,
    registry: EntityStorageRegistry,
    probe?: TransactionProbe,
  ): Promise<EntityStore> {
    const root = await realpath(path);
    invariant(
      (await exists(join(root, "storage.json"))) ||
        (await exists(join(root, "transactions/pending.json"))),
      "STORAGE_MIGRATION_REQUIRED",
      "Маркер единого хранилища отсутствует. Требуется явная миграция",
      4,
    );
    const store = new EntityStore(root, registry, probe);
    const transaction = new StorageTransaction(root);
    await transaction.prepareDirectories();
    await withStorageLock(
      root,
      async (owned) => {
        await transaction.recover(owned);
        store.formatVersion = storageManifestSchema.parse(
          await readJson(join(root, "storage.json")),
        ).schemaVersion;
      },
      transaction.runtime,
    );
    return store;
  }

  private async locked<T>(fn: (owned: () => void) => Promise<T>): Promise<T> {
    return withStorageLock(
      this.root,
      async (owned) => {
        await new StorageTransaction(this.root).recover(owned);
        this.formatVersion = storageManifestSchema.parse(
          await readJson(join(this.root, "storage.json")),
        ).schemaVersion;
        const result = await fn(owned);
        owned();
        return result;
      },
      join(this.root, "runtime"),
    );
  }

  async state(): Promise<StoreState> {
    try {
      return stateSchema.parse(await readJson(join(this.root, STATE_PATH)));
    } catch (error) {
      throw new AppError(
        "STORAGE_INDEX_CORRUPT",
        "Состояние индексов отсутствует или повреждено. Выполните перестроение",
        5,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  /** Короткое чтение под общей блокировкой исключает наблюдение частичной публикации. */
  async read<T>(fn: (snapshot: StorageSession) => Promise<T>): Promise<T> {
    return this.locked(async () => {
      this.requireCurrentFormat();
      const snapshot = new StorageSession(this, await this.state(), false);
      try {
        return await fn(snapshot);
      } finally {
        this.metrics.indexReads += snapshot.index.metrics.segmentReads;
      }
    });
  }

  async get(ref: EntityRef): Promise<EntityRecord> {
    return this.read((snapshot) => snapshot.get(ref));
  }
  async resolve(reference: string, expected?: string | readonly string[]): Promise<StorageCard> {
    return this.read((snapshot) => snapshot.resolve(reference, expected));
  }

  /** Повтор проверяется до ревизий и выполнения сценария и возвращает первоначальный результат. */
  async run<T extends JsonValue>(
    input: StorageCommand,
    fn: (transaction: StorageSession) => Promise<T>,
  ): Promise<T> {
    const command = commandSchema.parse(input);
    return this.locked(async (owned) => {
      this.requireCurrentFormat();
      const session = new StorageSession(this, await this.state(), true);
      const prior = await this.savedCommand(session, command);
      if (prior) return structuredClone(prior.result) as T;
      const result = jsonValue(await fn(session)) as T;
      await this.commitSession(session, command, result, owned);
      return structuredClone(result);
    });
  }

  /** Подключение внутри уже взятой блокировки Workspace; повторная блокировка не создаётся. */
  static async underLock(
    root: string,
    registry: EntityStorageRegistry,
    owned: () => void,
    initialize = false,
  ) {
    owned();
    const store = new EntityStore(await realpath(root), registry);
    const transaction = new StorageTransaction(store.root);
    await transaction.prepareDirectories();
    await transaction.recover(owned);
    if (!initialize)
      store.formatVersion = storageManifestSchema.parse(
        await readJson(join(store.root, "storage.json")),
      ).schemaVersion;
    return store;
  }

  /** Общая сессия составного предметного действия, в том числе вложенных вызовов репозиториев. */
  async transaction<T>(
    owned: () => void,
    fn: (session: StorageSession) => Promise<T>,
    initialize = false,
  ): Promise<T> {
    owned();
    this.requireCurrentFormat();
    const state =
      initialize && !(await exists(join(this.root, STATE_PATH)))
        ? structuredClone(EMPTY_STATE)
        : await this.state();
    const session = new StorageSession(this, state, true);
    const result = await fn(session);
    if (session.changed) {
      if (
        session.files.size === 0 &&
        session.command === undefined
      ) {
        await new StorageTransaction(this.root, this.probe).publish(
          await session.prepare(randomUUID()),
          owned,
        );
        session.index.published();
        return result;
      }
      if (session.command) {
        await this.commitSession(session, session.command.input, session.command.result, owned);
      } else {
        // Обслуживание без пользовательской команды не порождает искусственных квитанций.
        await new StorageTransaction(this.root, this.probe).publish(await session.prepare(randomUUID()), owned);
        session.index.published();
      }
    }
    owned();
    return result;
  }

  async savedCommand(
    session: StorageSession,
    input: StorageCommand,
  ): Promise<{ result: JsonValue } | undefined> {
    const command = commandSchema.parse(input);
    const key = receiptKey(command);
    const prior = await session.indexGet("receipts", key);
    if (prior === undefined) return undefined;
    const owners = z.array(entityRefSchema).parse(prior);
    invariant(
      owners.length === 1,
      "IDEMPOTENCY_CONFLICT",
      "Обнаружены разные квитанции одного запроса",
      4,
    );
    const raw = await session.readFile(this.registry.path(owners[0]!));
    invariant(raw, "STORAGE_INDEX_CORRUPT", "Потерян владелец квитанции", 5);
    const record = this.registry.validate(raw);
    invariant(sameRef(record, owners[0]!), "STORAGE_INDEX_CORRUPT", "Индекс квитанции указывает на чужую сущность", 5);
    const matches = record.receipts.filter((receipt) => receiptKey(receipt) === key);
    invariant(matches.length === 1, "STORAGE_INDEX_CORRUPT", "Индекс указывает на отсутствующую или повторную квитанцию", 5);
    const operation = matches[0]!;
    invariant(
      receiptKey(operation) === key &&
        operation.requestHash === digest(command.request),
      "IDEMPOTENCY_CONFLICT",
      "Ключ запроса уже использован с другим содержимым",
      4,
    );
    if (command.namespace === "board-task" || command.namespace === "task-comment") {
      const scoped = await session.taskReceipt(taskRequestKey(command.actor, command.requestId));
      invariant(scoped, "STORAGE_INDEX_CORRUPT", "Потерян индекс общей области задач и комментариев", 5);
      invariant(scoped.kind === (command.namespace === "board-task" ? "task" : "comment"),
        "IDEMPOTENCY_CONFLICT", "Ключ запроса занят в общей области задач и комментариев", 4);
    }
    return { result: operation.result };
  }

  private async commitSession(
    session: StorageSession,
    command: StorageCommand,
    result: JsonValue,
    owned: () => void,
  ) {
    this.requireCurrentFormat();
    await session.saveReceipt({
      actor: command.actor,
      namespace: command.namespace,
      requestId: command.requestId,
      requestHash: digest(command.request),
      result,
    });
    const prepared = await session.prepare(randomUUID());
    await new StorageTransaction(this.root, this.probe).publish(prepared, owned);
    session.index.published();
  }

  private requireCurrentFormat() {
    invariant(this.formatVersion === 3, "STORAGE_MIGRATION_REQUIRED", "Для работы с базой выполните storage migrate: требуется формат 3", 4);
  }

  /** Явное обслуживание сканирует постоянные файлы. Обычные резолвы сюда не попадают. */
  async reindex(externalOwned?: () => void): Promise<{
    entities: number;
    tombstones: number;
    operations: number;
    version: string;
  }> {
    const rebuild = async (owned: () => void) => {
      owned();
      this.requireCurrentFormat();
      forgetStorageSegments(this.root);
      let expectedPaths: string[] = [];
      try {
        const prior = new StorageSession(this, await this.state(), false);
        expectedPaths = (await prior.indexEntries("file-hashes")).map(([path]) => path);
      } catch (error) {
        // Отсутствующий/испорченный производный индекс можно восстановить по файлам.
        if (!(error instanceof AppError) || error.code !== "STORAGE_INDEX_CORRUPT") throw error;
      }
      for (const path of expectedPaths.filter((path) => /^(entities|relations|keyspaces)\//.test(path)))
        invariant(await exists(join(this.root, path)), "STORAGE_INDEX_CORRUPT", "Потерян ожидаемый постоянный файл; reindex не может принять его за удаление", 5, { path });
      const snapshot = new StorageSession(this, structuredClone(EMPTY_STATE), true);
      let entities = 0,
        tombstones = 0,
        operations = 0;
      this.metrics.directoryReads++;
      const collections = await directories(join(this.root, "entities"));
      const definitions = this.registry.definitions();
      invariant(
        collections.every((collection) =>
          definitions.some((entry) => entry.collection === collection),
        ),
        "UNKNOWN_ENTITY_KIND",
        "Коллекция базы не зарегистрирована; перестроение остановлено",
        4,
      );
      for (const definition of definitions) {
        this.metrics.directoryReads++;
        for (const filename of await jsonFiles(
          join(this.root, "entities", definition.collection),
        )) {
          const path = `entities/${definition.collection}/${filename}`;
          this.metrics.entityReads++;
          const raw = jsonValue(await readJson(join(this.root, path), Number.POSITIVE_INFINITY));
          const record = this.registry.validate(raw);
          snapshot.indexSet("file-hashes", path, digest(raw));
          invariant(
            this.registry.path(refOf(record)) === path,
            "INVALID_DATA",
            "Запись находится на чужом ID-пути",
            5,
          );
          await snapshot.indexRecord(record);
          if ("deleted" in record) tombstones++;
          else entities++;
        }
      }
      this.metrics.directoryReads++;
      for (const filename of await jsonFiles(join(this.root, "keyspaces"))) {
        const path = `keyspaces/${filename}`;
        const raw = jsonValue(await readJson(join(this.root, path), RECORD_BYTES));
        storedKeySpaceSchema.parse(raw);
        snapshot.indexSet("file-hashes", path, digest(raw));
      }
      await snapshot.rebuildRelations();
      const version = randomUUID();
      const changes = await snapshot.prepare(version);
      // Перестроение не меняет факты. Новые неизменяемые страницы подготавливаются до
      // публикации корней; прерывание оставляет прежний снимок и только лишние кеш-файлы.
      // В WAL попадают корни, а не весь индекс базы, который может превышать размер операции.
      const transaction = new StorageTransaction(this.root, this.probe);
      await transaction.stageIndexes(changes.slice(0, -1), owned);
      await transaction.publish([changes.at(-1)!], owned);
      snapshot.index.published();
      const published = stateSchema.parse(changes.at(-1)!.after);
      const live = await snapshot.index.liveSegments(Object.values(published.roots));
      const segments = join(this.root, ".indexes/segments");
      for (const shard of await directories(segments))
        for (const filename of await jsonFiles(join(segments, shard)))
          if (/^[a-f0-9]{64}\.json$/.test(filename) && !live.has(filename.slice(0, -5))) {
            owned();
            await unlink(join(segments, shard, filename));
          }
      return { entities, tombstones, operations, version };
    };
    return externalOwned ? rebuild(externalOwned) : this.locked(rebuild);
  }

  /** Единственный прямой переход физического формата, без промежуточного журнала. */
  async migrateFormat(owned: () => void, input: StorageMigrationOptions = {}) {
    owned();
    const options = storageMigrationOptionsSchema.parse(input);
    const manifest = storageManifestSchema.parse(await readJson(join(this.root, "storage.json")));
    if (manifest.schemaVersion !== 3) {
      const { migrateUnifiedStorage } = await import("../migration/unified.js");
      return migrateUnifiedStorage(this, owned, options);
    }
    const orphanPlanning = options.orphanPlanning
      ? await verifyAppliedOrphanPlanningApproval(new StorageSession(this, await this.state(), false), options.orphanPlanning)
      : undefined;
    return {
      migrated: false,
      format: "relay-entities",
      schemaVersion: 3,
      entities: 0,
      operations: 0,
      ...(orphanPlanning ? { orphanPlanning } : {}),
    };
  }
}

/** Рабочий пакет. Непубликуемые предметные записи доступны следующим явным шагам сценария. */
export class StorageSession {
  operationId: string = randomUUID();
  readonly index: HashIndex;
  readonly files = new Map<string, JsonValue | null>();
  readonly originals = new Map<string, JsonValue | null>();
  readonly touched = new Set<string>();
  command: { input: StorageCommand; result: JsonValue } | undefined;
  private commandOwner: EntityRef | undefined;
  private replayOwner: EntityRef | undefined;
  get executingCommand() { return this.executing; }
  get hasCommandOwner() { return this.commandOwner !== undefined; }
  commandNamespace: string | undefined;
  private executing = false;
  private readonly updates = new Map<string, Map<string, JsonValue | undefined>>();
  constructor(
    readonly store: EntityStore,
    readonly state: StoreState,
    private readonly writable: boolean,
  ) {
    this.index = new HashIndex(store.root);
  }

  /** В составной команде владелец задаётся прикладным сценарием, а не порядком записи. */
  setCommandOwner(ref: EntityRef) {
    invariant(this.writable, "READ_ONLY_SNAPSHOT", "Снимок доступен только для чтения", 5);
    const owner = entityRefSchema.parse(ref);
    invariant(!this.commandOwner || sameRef(this.commandOwner, owner), "STORAGE_COMMAND_OWNER_CONFLICT", "Команда уже имеет другого основного владельца", 5);
    this.commandOwner = owner;
  }

  async saveReceipt(input: z.input<typeof storedReceiptSchema>) {
    const receipt = storedReceiptSchema.parse(input);
    // Единственная изменённая сущность однозначна; для составных действий нужен явный владелец.
    const address = this.touched.size === 1 ? [...this.touched][0] : undefined;
    const owner = this.commandOwner ?? this.replayOwner ?? (address ? entityRefSchema.parse({ kind: address.split(":")[0], id: address.split(":")[1] }) : undefined);
    invariant(owner, "STORAGE_COMMAND_OWNER_REQUIRED", "Составная команда должна указать основного владельца квитанции", 5);
    await this.putReceipt(owner, receipt);
  }

  /** Импорт и совместимые предметные повторы не меняют основного владельца текущей команды. */
  async putReceipt(owner: EntityRef, input: z.input<typeof storedReceiptSchema>) {
    const receipt = storedReceiptSchema.parse(input);
    const path = this.store.registry.path(owner);
    const raw = await this.readFile(path);
    invariant(raw, "ENTITY_NOT_FOUND", "Владелец квитанции не найден", 3);
    const record = this.store.registry.validate(raw);
    const key = receiptKey(receipt);
    const previous = record.receipts.find((entry) => receiptKey(entry) === key);
    invariant(!previous || digest(previous) === digest(receipt), "IDEMPOTENCY_CONFLICT", "Квитанция запроса уже имеет другое содержание", 4);
    if (!previous) record.receipts.push(receipt);
    await this.writeFile(path, jsonValue(record));
    await this.indexReceipt(owner, receipt);
  }

  async saveCompatibilityReceipt(owner: EntityRef, namespace: string, key: string, value: JsonValue) {
    await this.putReceipt(owner, {
      namespace: `legacy:${namespace}`, actor: "relay", requestId: digest(key),
      requestHash: digest(value), result: { key, value },
    });
  }

  async compatibilityReceipt(namespace: string, key: string): Promise<JsonValue | undefined> {
    const identity = { namespace: `legacy:${namespace}`, actor: "relay", requestId: digest(key) };
    const owners = z.array(entityRefSchema).parse((await this.indexGet("receipts", receiptKey(identity))) ?? []);
    if (!owners.length) return undefined;
    invariant(owners.length === 1, "IDEMPOTENCY_CONFLICT", "Разные владельцы прежней квитанции", 4);
    const raw = await this.readFile(this.store.registry.path(owners[0]!));
    invariant(raw, "STORAGE_INDEX_CORRUPT", "Потерян владелец прежней квитанции", 5);
    const stored = this.store.registry.validate(raw);
    const receipt = stored.receipts.find((entry) => receiptKey(entry) === receiptKey(identity));
    invariant(receipt, "STORAGE_INDEX_CORRUPT", "Потеряна прежняя квитанция", 5);
    const result = z.object({ key: z.literal(key), value: z.json() }).parse(receipt.result);
    invariant(receipt.requestHash === digest(result.value), "STORAGE_INDEX_CORRUPT", "Повреждена прежняя квитанция", 5);
    this.replayOwner = owners[0];
    return structuredClone(result.value);
  }

  /** Общая предметная область task/comment включает живых владельцев и tombstones. */
  async taskReceipt(key: string): Promise<{ kind: "task" | "comment"; hash: string; result: JsonValue } | undefined> {
    let pointer = await this.indexGetParsed("task-request-receipts", key, taskReceiptPointerSchema);
    if (await this.indexGet("receipt-index-meta", "task-request-receipts") !== 1) {
      // Старые v3-индексы ещё не содержат этой производной выборки. Читаем исходный
      // receipt→owner индекс без скрытой записи; явный reindex строит полную выборку.
      for (const [identity, rawOwners] of await this.indexEntries("receipts")) {
        const [namespace, actor, requestId] = z.tuple([z.string(), z.string(), z.string()]).parse(JSON.parse(identity));
        const relevant = namespace === "board-task" || namespace === "task-comment"
          ? taskRequestKey(actor, requestId) === key
          : (namespace.startsWith("legacy:record:task:") || namespace === "legacy:task-comment-receipt") && requestId === digest(key);
        if (!relevant) continue;
        for (const owner of z.array(entityRefSchema).parse(rawOwners)) {
          const raw = await this.readFile(this.store.registry.path(owner));
          invariant(raw, "STORAGE_INDEX_CORRUPT", "Потерян владелец квитанции задачи", 5);
          const record = this.store.registry.validate(raw);
          invariant(sameRef(record, owner), "STORAGE_INDEX_CORRUPT", "Неверный владелец квитанции задачи", 5);
          const matches = record.receipts.filter((entry) => receiptKey(entry) === identity);
          invariant(matches.length === 1, "STORAGE_INDEX_CORRUPT", "Квитанция задачи потеряна или дублирована", 5);
          const receipt = matches[0]!;
          const scoped = taskReceiptScope(owner, receipt);
          invariant(scoped?.key === key, "STORAGE_INDEX_CORRUPT", "Индекс ведёт к чужому ключу запроса", 5);
          pointer = mergeTaskReceipt(pointer, scoped.pointer);
        }
      }
    }
    if (!pointer) return undefined;
    const raw = await this.readFile(this.store.registry.path(pointer.owner));
    invariant(raw, "STORAGE_INDEX_CORRUPT", "Потерян владелец квитанции задачи", 5);
    const record = this.store.registry.validate(raw);
    invariant(sameRef(record, pointer.owner), "STORAGE_INDEX_CORRUPT", "Неверный владелец квитанции задачи", 5);
    const matches = record.receipts.filter((entry) => receiptKey(entry) === pointer.identity);
    invariant(matches.length === 1, "STORAGE_INDEX_CORRUPT", "Квитанция задачи потеряна или дублирована", 5);
    const receipt = matches[0]!;
    const scoped = taskReceiptScope(pointer.owner, receipt);
    invariant(scoped?.key === key && scoped.pointer.kind === pointer.kind && scoped.pointer.form === pointer.form, "STORAGE_INDEX_CORRUPT", "Неверная область квитанции задачи", 5);
    this.replayOwner = pointer.owner;
    if (pointer.form === "native") return { kind: pointer.kind, hash: receipt.requestHash, result: receipt.result };
    const value = z.object({ key: z.literal(key), value: z.json() }).parse(receipt.result);
    invariant(digest(value.value) === receipt.requestHash, "STORAGE_INDEX_CORRUPT", "Повреждена прежняя квитанция задачи", 5);
    const saved = z.object({ hash: z.string(), result: z.json() }).parse(value.value);
    return { kind: pointer.kind, ...saved };
  }

  /** Разрешение для проверки повтора допускает tombstone, но не возвращает живую сущность. */
  async resolveReceiptTarget(reference: string, kind: string): Promise<EntityRef> {
    try {
      return (await this.resolve(reference, kind)).ref;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "ENTITY_DELETED") throw error;
      const { ref } = z.object({ ref: entityRefSchema }).parse(error.details);
      invariant(ref.kind === kind, "ENTITY_KIND_MISMATCH", "Другой вид владельца квитанции", 4);
      return ref;
    }
  }

  private async indexReceipt(owner: EntityRef, receipt: z.output<typeof storedReceiptSchema>) {
    const key = receiptKey(receipt);
    const owners = z.array(entityRefSchema).parse((await this.indexGet("receipts", key)) ?? []);
    if (!owners.some((ref) => sameRef(ref, owner))) owners.push(owner);
    invariant(owners.length === 1, "IDEMPOTENCY_CONFLICT", "Квитанция одного запроса обнаружена у разных владельцев", 4);
    this.indexSet("receipts", key, owners);
    if (this.state.roots.receipts == null) this.indexSet("receipt-index-meta", "task-request-receipts", 1);
    const scoped = taskReceiptScope(owner, receipt);
    if (scoped) {
      const before = await this.indexGetParsed("task-request-receipts", scoped.key, taskReceiptPointerSchema);
      this.indexSet("task-request-receipts", scoped.key, mergeTaskReceipt(before, scoped.pointer));
    }
  }

  /** Комментарий меняет только собственную ленту, не содержание и ревизию задачи. */
  async appendComment(ref: EntityRef, input: z.input<typeof storedCommentSchema>) {
    const comment = storedCommentSchema.parse(input);
    invariant(ref.kind === "task" && comment.taskId === ref.id, "ENTITY_KIND_MISMATCH", "Комментарий должен принадлежать указанной задаче", 4);
    const record = this.store.registry.encode(await this.get(ref));
    invariant(comment.revision === record.revision, "REVISION_CONFLICT", "Ревизия содержания задачи изменилась", 4);
    invariant(comment.id === String(comment.sequence) && comment.sequence === (record.commentSequence ?? 0) + 1, "INVALID_DATA", "Номер нового комментария должен продолжать последовательность задачи", 5);
    record.comments = [...(record.comments ?? []), comment];
    record.commentSequence = comment.sequence;
    await this.writeFile(this.store.registry.path(ref), jsonValue(record));
    this.touched.add(entityAddress(ref));
  }

  /** Только предметные события планирования; универсальные снимки сюда не принимаются. */
  async appendPlanningEvent(ref: EntityRef, input: z.input<typeof storedPlanningEventSchema>) {
    invariant(ref.kind === "work-plan" || ref.kind === "release", "ENTITY_KIND_MISMATCH", "Событие принадлежит плану или релизу", 4);
    const event = storedPlanningEventSchema.parse(input);
    const record = this.store.registry.encode(await this.get(ref));
    invariant(event.revision === record.revision, "REVISION_CONFLICT", "Ревизия события не совпадает с планом или релизом", 4);
    record.planningEvents = [...(record.planningEvents ?? []), event];
    await this.writeFile(this.store.registry.path(ref), jsonValue(record));
    this.touched.add(entityAddress(ref));
  }

  get changed() {
    return (
      this.files.size > 0 ||
      this.updates.size > 0 ||
      this.command !== undefined
    );
  }

  async execute<T extends JsonValue>(
    input: StorageCommand,
    operation: () => Promise<T>,
  ): Promise<T> {
    const command = commandSchema.parse(input);
    const previous = await this.store.savedCommand(this, command);
    if (previous) return structuredClone(previous.result) as T;
    if (this.executing) return jsonValue(await operation()) as T;
    invariant(
      !this.command,
      "NESTED_STORAGE_COMMAND",
      "В одной операции допускается один внешний ключ повтора",
      5,
    );
    this.executing = true;
    this.commandNamespace = command.namespace;
    try {
      const result = jsonValue(await operation()) as T;
      this.command = { input: command, result };
      return result;
    } finally {
      this.executing = false;
      this.commandNamespace = undefined;
    }
  }

  async indexEntries(name: string): Promise<[string, JsonValue][]> {
    const entries = new Map(await this.index.entries(this.state.roots[name] ?? null));
    for (const [key, value] of this.updates.get(name) ?? []) {
      if (value === undefined) entries.delete(key);
      else entries.set(key, structuredClone(value));
    }
    return [...entries];
  }

  async records(kind: string): Promise<EntityRecord[]> {
    const refs = (await this.indexEntries("records"))
      .map(([, value]) => z.object({ ref: entityRefSchema, deleted: z.boolean() }).parse(value))
      .filter((entry) => entry.ref.kind === kind && !entry.deleted);
    return Promise.all(refs.map((entry) => this.get(entry.ref)));
  }

  /** Явный перенос дисковой записи сохраняет исходную ревизию и не выдаётся за пользовательскую правку. */
  async importRecord(input: EntityRecord): Promise<void> {
    const record = this.store.registry.encode(input);
    const path = this.store.registry.path(record);
    const previous = await this.readFile(path);
    invariant(
      previous === null || digest(previous) === digest(jsonValue(record)),
      "STORAGE_MIGRATION_CONFLICT",
      "Целевая запись уже отличается от переносимой",
      5,
    );
    await this.writeFile(path, jsonValue(record));
    await this.indexRecord(record);
    this.touched.add(entityAddress(record));
  }

  async reserveLegacyKey(key: string) {
    const projects = await this.records("project");
    invariant(projects.length === 1, "INVALID_DATA", "Для переноса резервов требуется проект", 5);
    const project = this.store.registry.encode(projects[0]!);
    project.reservedKeys = [...new Set([...(project.reservedKeys ?? []), key])];
    await this.writeFile(this.store.registry.path(project), jsonValue(project));
    this.indexSet("reserved-key", key, true);
    await this.indexNumber(key);
  }

  async indexNumber(value: string) {
    const numbered = /^(.*)-([1-9]\d*)$/.exec(value);
    if (!numbered || !Number.isSafeInteger(Number(numbered[2]))) return;
    const before = z.number().parse((await this.indexGet("numbers", numbered[1]!)) ?? 0);
    this.indexSet("numbers", numbered[1]!, Math.max(before, Number(numbered[2])));
  }

  async indexGet(name: string, key: string): Promise<JsonValue | undefined> {
    const changes = this.updates.get(name);
    if (changes?.has(key)) return structuredClone(changes.get(key));
    return this.index.get(this.state.roots[name] ?? null, key);
  }
  async indexGetParsed<T>(name: string, key: string, schema: z.ZodType<T>): Promise<T | undefined> {
    const changes = this.updates.get(name);
    if (changes?.has(key)) {
      const value = changes.get(key);
      return value === undefined ? undefined : schema.parse(value);
    }
    return this.index.getParsed(this.state.roots[name] ?? null, key, schema);
  }
  indexSet(name: string, key: string, value: JsonValue | undefined) {
    invariant(this.writable, "READ_ONLY_SNAPSHOT", "Снимок доступен только для чтения", 5);
    let changes = this.updates.get(name);
    if (!changes) this.updates.set(name, (changes = new Map()));
    changes.set(key, structuredClone(value));
  }
  async readFile(path: string): Promise<JsonValue | null> {
    if (this.files.has(path)) return structuredClone(this.files.get(path)!);
    if (!this.originals.has(path)) {
      const full = join(this.store.root, path);
      if (await exists(full)) {
        if (path.startsWith("entities/")) this.store.metrics.entityReads++;
        if (path.startsWith("relations/")) this.store.metrics.relationReads++;
        this.originals.set(path, jsonValue(await readJson(full, path.startsWith("entities/") ? Number.POSITIVE_INFINITY : RECORD_BYTES)));
      } else this.originals.set(path, null);
    }
    return structuredClone(this.originals.get(path)!);
  }
  async writeFile(path: string, value: JsonValue | null): Promise<void> {
    invariant(this.writable, "READ_ONLY_SNAPSHOT", "Снимок доступен только для чтения", 5);
    invariant(value === null || !/^(history|operations|audit|receipts)\//.test(path), "STORAGE_LEGACY_WRITER", "Общие журналы больше не записываются", 5, { path });
    const before = await this.readFile(path);
    if (digest(before) !== digest(value)) this.files.set(path, structuredClone(value));
    if (/^(entities|relations|keyspaces|operations|history)\//.test(path))
      this.indexSet("file-hashes", path, value === null ? undefined : digest(value));
  }
  async get(ref: EntityRef): Promise<EntityRecord> {
    const path = this.store.registry.path(ref);
    const raw = await this.readFile(path);
    invariant(raw, "ENTITY_NOT_FOUND", "Сущность не найдена в выбранном проекте", 3);
    const record = this.store.registry.decode(raw);
    invariant(sameRef(record, ref), "INVALID_DATA", "Файл содержит другую сущность", 5);
    return record;
  }

  async resolve(reference: string, expected?: string | readonly string[]): Promise<StorageCard> {
    entityReferenceSchema.parse(reference);
    const pieces = reference.split(":");
    invariant(pieces.length <= 2, "INVALID_REFERENCE", "Ожидается ключ, ID или kind:ID", 4);
    const kind = pieces.length === 2 ? pieces[0] : undefined;
    const value = pieces.at(-1)!;
    const kinds = typeof expected === "string" ? [expected] : expected;
    invariant(
      !kind || !kinds || kinds.includes(kind),
      "ENTITY_KIND_MISMATCH",
      "Вид ссылки не соответствует действию",
      4,
    );
    if (kind) {
      const raw = await this.readFile(this.store.registry.path({ kind, id: value }));
      if (raw) {
        const record = this.store.registry.validate(raw);
        invariant(
          record.kind === kind && record.id === value,
          "INVALID_DATA",
          "Файл содержит другую сущность",
          5,
        );
        invariant(
          !("deleted" in record),
          "ENTITY_DELETED",
          "Сущность удалена; адрес зарезервирован",
          3,
          { ref: refOf(record) },
        );
        const card = await this.indexGet("cards", entityAddress(refOf(record)));
        invariant(card, "STORAGE_INDEX_CORRUPT", "Карточка разрешённого адреса потеряна", 5);
        return storageCardSchema.parse(card);
      }
    }
    const all = candidatesSchema
      .parse((await this.indexGet("addresses", value)) ?? [])
      .filter((entry) => !kind || entry.ref.kind === kind);
    const candidates = all.filter((entry) => !kinds || kinds.includes(entry.ref.kind));
    if (!candidates.length && kinds?.length === 1) {
      const selected = z
        .array(entityRefSchema)
        .parse((await this.indexGet("selectors", JSON.stringify([kinds[0], value]))) ?? []);
      candidates.push(...selected.map((ref) => ({ ref, matches: [], deleted: false })));
    }
    invariant(
      candidates.length > 0,
      all.length ? "ENTITY_KIND_MISMATCH" : "ENTITY_NOT_FOUND",
      all.length ? "Сущность имеет другой вид" : `Сущность ${reference} не найдена`,
      all.length ? 4 : 3,
    );
    invariant(
      candidates.length === 1,
      "AMBIGUOUS_ENTITY_REFERENCE",
      "Адрес неоднозначен. Укажите вид и постоянный ID",
      4,
      { candidates: candidates.map(({ ref }) => ref) },
    );
    const candidate = candidates[0]!;
    invariant(!candidate.deleted, "ENTITY_DELETED", "Сущность удалена; адрес зарезервирован", 3, {
      ref: candidate.ref,
    });
    const card = await this.indexGet("cards", entityAddress(candidate.ref));
    invariant(card, "STORAGE_INDEX_CORRUPT", "Карточка разрешённого адреса потеряна", 5);
    return storageCardSchema.parse(card);
  }

  /** Проверка новых ключей не блокирует изменение по ID при уже существующей merge-коллизии. */
  async put(record: EntityRecord, ifRevision: number | null): Promise<void> {
    const stored = this.store.registry.encode(record);
    const ref = refOf(stored);
    const path = this.store.registry.path(ref);
    const raw = await this.readFile(path);
    const previous = raw ? this.store.registry.validate(raw) : undefined;
    if (previous) {
      // Предметные адаптеры не вправе стирать технические квитанции или собственные ленты.
      stored.receipts = previous.receipts;
      if (previous.comments !== undefined) stored.comments = previous.comments;
      if (previous.commentSequence !== undefined) stored.commentSequence = previous.commentSequence;
      if (previous.planningEvents !== undefined) stored.planningEvents = previous.planningEvents;
      if (previous.reservedKeys !== undefined) stored.reservedKeys = previous.reservedKeys;
    }
    invariant(
      !previous || sameRef(previous, ref),
      "INVALID_DATA",
      "Файл содержит другую сущность",
      5,
    );
    invariant(
      !previous || !("deleted" in previous),
      "ENTITY_DELETED",
      "Удалённый ID нельзя использовать повторно",
      4,
    );
    invariant(
      ifRevision === null ? !previous : previous?.revision === ifRevision,
      "REVISION_CONFLICT",
      "Сущность изменилась. Прочитайте актуальную ревизию",
      4,
    );
    invariant(
      stored.revision === (previous?.revision ?? 0) + 1,
      "INVALID_REVISION",
      "Новая запись должна увеличивать предметную ревизию на один",
      4,
    );
    invariant(
      !previous ||
        previous.revision === 0 ||
        (stored.createdAt === previous.createdAt && stored.createdBy === previous.createdBy),
      "IMMUTABLE_ENTITY_ORIGIN",
      "Автор и время создания сущности неизменяемы",
      4,
    );
    const beforeKeys = previous
      ? [previous.key, ...previous.aliases].filter((key): key is string => key !== null)
      : [];
    const afterKeys = [stored.key, ...stored.aliases].filter((key): key is string => key !== null);
    invariant(
      beforeKeys.every((key) => afterKeys.includes(key)),
      "ENTITY_ALIAS_REQUIRED",
      "Прежние ключи должны сохраняться как алиасы",
      4,
    );
    for (const key of afterKeys.filter((key) => !beforeKeys.includes(key))) {
      const candidates = candidatesSchema.parse((await this.indexGet("addresses", key)) ?? []);
      invariant(
        candidates.every((candidate) => sameRef(candidate.ref, ref)) &&
          (await this.indexGet("reserved-key", key)) === undefined,
        "ENTITY_KEY_CONFLICT",
        "Ключ занят либо зарезервирован за другой сущностью",
        4,
      );
    }
    await this.writeFile(path, jsonValue(stored));
    await this.indexRecord(stored);
    this.touched.add(entityAddress(ref));
  }

  async remove(ref: EntityRef, ifRevision: number, actor: string): Promise<void> {
    const record = await this.get(ref);
    invariant(record.revision === ifRevision, "REVISION_CONFLICT", "Сущность изменилась", 4);
    invariant(
      (await this.postings("adjacency", entityAddress(ref))).length === 0,
      "ENTITY_HAS_RELATIONS",
      "Сначала отзовите связи удаляемой сущности",
      4,
    );
    const {
      data: _data,
      createdAt: _createdAt,
      createdBy: _createdBy,
      updatedAt: _updatedAt,
      updatedBy: _updatedBy,
      ...identity
    } = record;
    const tombstone = this.store.registry.validate({
      ...identity,
      revision: record.revision + 1,
      deleted: { actor: actorSchema.parse(actor), at: new Date().toISOString() },
      schemaVersion: 2,
    });
    await this.writeFile(this.store.registry.path(ref), jsonValue(tombstone));
    await this.indexRecord(tombstone);
    this.touched.add(entityAddress(ref));
  }

  async indexRecord(record: StoredRecord) {
    const ref = refOf(record);
    const address = entityAddress(ref);
    this.indexSet("records", address, { ref, deleted: "deleted" in record });
    for (const key of record.reservedKeys ?? []) {
      this.indexSet("reserved-key", key, true);
      await this.indexNumber(key);
    }
    const receiptKeys = new Set<string>();
    for (const receipt of record.receipts) {
      const key = receiptKey(receipt);
      invariant(!receiptKeys.has(key), "IDEMPOTENCY_CONFLICT", "Повторный ключ квитанции внутри владельца", 4);
      receiptKeys.add(key);
      await this.indexReceipt(ref, receipt);
    }
    if (!("deleted" in record))
      for (const item of this.store.registry
        .definition(record.kind)
        .indexes?.(this.store.registry.decode(record)) ?? [])
        this.indexSet(item.index, item.key, item.value);
    if (this.store.registry.definition(record.kind).addressable === false) return;
    const names = new Map<string, Candidate["matches"]>();
    for (const [value, match] of [
      [record.id, "id"],
      ...(record.key === null ? [] : [[record.key, "key"]]),
      ...record.aliases.map((key) => [key, "alias"]),
    ] as [string, Candidate["matches"][number]][]) {
      const matches = names.get(value) ?? [];
      if (!matches.includes(match)) matches.push(match);
      names.set(value, matches);
    }
    for (const [value, matches] of names) {
      const candidates = candidatesSchema.parse((await this.indexGet("addresses", value)) ?? []);
      this.indexSet(
        "addresses",
        value,
        [
          ...candidates.filter((entry) => !sameRef(entry.ref, ref)),
          { ref, matches, deleted: "deleted" in record },
        ].sort((a, b) => entityAddress(a.ref).localeCompare(entityAddress(b.ref))),
      );
      const numbered = /^(.*)-([1-9]\d*)$/.exec(value);
      if (numbered && Number.isSafeInteger(Number(numbered[2]))) {
        const before = z.number().parse((await this.indexGet("numbers", numbered[1]!)) ?? 0);
        this.indexSet("numbers", numbered[1]!, Math.max(before, Number(numbered[2])));
      }
    }
    const oldCard = await this.indexGet("cards", address);
    const oldSelectors = oldCard ? storageCardSchema.parse(oldCard).selectors : [];
    const card = "deleted" in record ? undefined : this.store.registry.card(record);
    for (const selector of new Set([...oldSelectors, ...(card?.selectors ?? [])])) {
      const key = JSON.stringify([record.kind, selector]);
      const others = z
        .array(entityRefSchema)
        .parse((await this.indexGet("selectors", key)) ?? [])
        .filter((candidate) => !sameRef(candidate, ref));
      if (card?.selectors.includes(selector)) others.push(ref);
      this.indexSet("selectors", key, others.length ? others : undefined);
    }
    this.indexSet(
      "cards",
      address,
      card === undefined ? undefined : jsonValue(JSON.parse(JSON.stringify(card))),
    );
  }

  async saveKeySpace(input: StoredKeySpace) {
    const space = storedKeySpaceSchema.parse(input);
    this.store.registry.definition(space.entityKind);
    await this.get(space.owner);
    const raw = await this.readFile(`keyspaces/${space.id}.json`);
    if (raw) {
      const previous = storedKeySpaceSchema.parse(raw);
      invariant(
        previous.id === space.id &&
          previous.entityKind === space.entityKind &&
          sameRef(previous.owner, space.owner),
        "IMMUTABLE_KEYSPACE_OWNER",
        "Вид и владелец пространства ключей неизменяемы",
        4,
      );
    }
    await this.writeFile(`keyspaces/${space.id}.json`, space);
  }
  async nextKey(spaceId: string): Promise<string> {
    const id = storedKeySpaceSchema.shape.id.parse(spaceId);
    const space = storedKeySpaceSchema.parse(await this.readFile(`keyspaces/${id}.json`));
    invariant(space.id === id, "INVALID_DATA", "Неверный ID пространства ключей", 5);
    let number = z.number().parse((await this.indexGet("numbers", space.prefix)) ?? 0);
    let key: string;
    do {
      number++;
      invariant(Number.isSafeInteger(number), "KEYSPACE_EXHAUSTED", "Номера ключей исчерпаны", 4);
      key = `${space.prefix}-${number}`;
    } while (
      (await this.indexGet("addresses", key)) !== undefined ||
      (await this.indexGet("reserved-key", key)) !== undefined
    );
    this.indexSet("numbers", space.prefix, number);
    return key;
  }

  /** Короткие списки размещаются вместе в сегменте; длинные получают делимое дерево. */
  async postings(name: string, key: string): Promise<string[]> {
    return this.indexPostings(name, key);
  }
  async indexPostings(name: string, key: string): Promise<string[]> {
    const value = await this.indexGetParsed(name, key, postingValueSchema);
    if (value === undefined) return [];
    if (Array.isArray(value)) return value;
    return (await this.index.entries(value.root)).map(([entry]) => entry);
  }
  async addPosting(name: string, key: string, id: string, remove = false) {
    const value = await this.indexGet(name, key);
    if (value !== undefined && !Array.isArray(value)) {
      const { root } = postingPointerSchema.parse(value);
      const next = await this.index.update(root, new Map([[id, remove ? undefined : true]]));
      this.indexSet(name, key, next ? { root: next } : undefined);
      return;
    }
    const ids = new Set(postingIdsSchema.parse(value ?? []));
    if (remove) ids.delete(id);
    else ids.add(id);
    if (ids.size <= 128) this.indexSet(name, key, ids.size ? [...ids].sort() : undefined);
    else {
      const root = await this.index.update(null, new Map([...ids].map((entry) => [entry, true])));
      this.indexSet(name, key, { root: root! });
    }
  }

  async rebuildRelations(): Promise<void> {
    const { rebuildOwnedRelations } = await import("./relations.js");
    await rebuildOwnedRelations(this);
  }

  async prepare(version: string): Promise<FileChange[]> {
    const roots = { ...this.state.roots };
    for (const [name, changes] of this.updates)
      roots[name] = await this.index.update(roots[name] ?? null, changes);
    return [
      ...[...this.files].map(([path, after]) => ({
        path,
        after,
        before: this.originals.get(path) === null ? null : digest(this.originals.get(path)!),
      })),
      ...this.index.changes(Object.values(roots)),
      { path: STATE_PATH, after: { schemaVersion: 1, version, roots } },
    ];
  }

  async snapshotRoots() {
    if (!this.changed) return this.state.roots;
    return stateSchema.parse((await this.prepare(this.state.version)).at(-1)!.after).roots;
  }
}
