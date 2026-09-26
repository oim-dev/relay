import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  storageManifestSchema,
  storedKeySpaceSchema,
  storageCardSchema,
  storedCommentSchema,
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
import { storageMigrationOptionsSchema } from "../migration/options.js";
import type { StorageMigrationOptions } from "../migration/options.js";

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
  formatVersion: 1 | 2 | 3 | 4 = 4;
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
            { path: "storage.json", after: { format: "relay-entities", schemaVersion: 4 } },
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

  /** Каждый вызов исполняется заново; requestId служит только корреляции. */
  async run<T extends JsonValue>(
    input: StorageCommand,
    fn: (transaction: StorageSession) => Promise<T>,
  ): Promise<T> {
    commandSchema.parse(input);
    return this.locked(async (owned) => {
      this.requireCurrentFormat();
      const session = new StorageSession(this, await this.state(), true);
      const result = jsonValue(await fn(session)) as T;
      if (session.changed) await this.commitSession(session, owned);
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
    if (session.changed) await this.commitSession(session, owned);
    owned();
    return result;
  }

  private async commitSession(session: StorageSession, owned: () => void) {
    this.requireCurrentFormat();
    const prepared = await session.prepare(randomUUID());
    await new StorageTransaction(this.root, this.probe).publish(prepared, owned);
    session.index.published();
  }

  private requireCurrentFormat() {
    invariant(
      this.formatVersion === 4,
      "STORAGE_MIGRATION_REQUIRED",
      "Для работы с базой выполните storage migrate: требуется формат 4",
      4,
    );
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
      for (const path of expectedPaths.filter((path) =>
        /^(entities|relations|keyspaces)\//.test(path),
      ))
        invariant(
          await exists(join(this.root, path)),
          "STORAGE_INDEX_CORRUPT",
          "Потерян ожидаемый постоянный файл; reindex не может принять его за удаление",
          5,
          { path },
        );
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
    if (manifest.schemaVersion !== 4) {
      const { migrateUnifiedStorage } = await import("../migration/unified.js");
      return migrateUnifiedStorage(this, owned, options);
    }
    return {
      migrated: false,
      format: "relay-entities",
      schemaVersion: 4,
      entities: 0,
      operations: 0,
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
  private executed = false;
  private executing = false;
  private readonly updates = new Map<string, Map<string, JsonValue | undefined>>();
  constructor(
    readonly store: EntityStore,
    readonly state: StoreState,
    private readonly writable: boolean,
  ) {
    this.index = new HashIndex(store.root);
  }

  /** Комментарий меняет только собственную ленту, не содержание и ревизию задачи. */
  async appendComment(ref: EntityRef, input: z.input<typeof storedCommentSchema>) {
    const comment = storedCommentSchema.parse(input);
    invariant(
      ref.kind === "task" && comment.taskId === ref.id,
      "ENTITY_KIND_MISMATCH",
      "Комментарий должен принадлежать указанной задаче",
      4,
    );
    const record = this.store.registry.encode(await this.get(ref));
    invariant(
      comment.revision === record.revision,
      "REVISION_CONFLICT",
      "Ревизия содержания задачи изменилась",
      4,
    );
    invariant(
      comment.id === String(comment.sequence) &&
        comment.sequence === (record.commentSequence ?? 0) + 1,
      "INVALID_DATA",
      "Номер нового комментария должен продолжать последовательность задачи",
      5,
    );
    record.comments = [...(record.comments ?? []), comment];
    record.commentSequence = comment.sequence;
    await this.writeFile(this.store.registry.path(ref), jsonValue(record));
    this.touched.add(entityAddress(ref));
  }

  get changed() {
    return this.files.size > 0 || this.updates.size > 0;
  }

  async execute<T extends JsonValue>(
    input: StorageCommand,
    operation: () => Promise<T>,
  ): Promise<T> {
    commandSchema.parse(input);
    if (this.executing) return jsonValue(await operation()) as T;
    invariant(
      !this.executed,
      "NESTED_STORAGE_COMMAND",
      "В одной транзакции допускается одна внешняя команда",
      5,
    );
    this.executing = true;
    try {
      const result = jsonValue(await operation()) as T;
      this.executed = true;
      return result;
    } finally {
      this.executing = false;
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
        this.originals.set(
          path,
          jsonValue(
            await readJson(
              full,
              path.startsWith("entities/") ? Number.POSITIVE_INFINITY : RECORD_BYTES,
            ),
          ),
        );
      } else this.originals.set(path, null);
    }
    return structuredClone(this.originals.get(path)!);
  }
  async writeFile(path: string, value: JsonValue | null): Promise<void> {
    invariant(this.writable, "READ_ONLY_SNAPSHOT", "Снимок доступен только для чтения", 5);
    invariant(
      value === null ||
        !/(^|\/)(history|operations|audit|events|receipts|requests|planningEvents)\//.test(path),
      "STORAGE_LEGACY_WRITER",
      "Автоматические журналы и квитанции больше не записываются",
      5,
      { path },
    );
    if (value !== null && path.startsWith("entities/")) this.store.registry.validate(value);
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
      // Предметные адаптеры не вправе стирать опубликованные комментарии.
      if (previous.comments !== undefined) stored.comments = previous.comments;
      if (previous.commentSequence !== undefined) stored.commentSequence = previous.commentSequence;
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
      schemaVersion: 3,
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
    const before = await this.index.liveSegments(Object.values(this.state.roots));
    const after = await this.index.liveSegments(Object.values(roots));
    const obsolete: FileChange[] = [...before]
      .filter((hash) => !after.has(hash))
      .map((hash) => ({
        path: `.indexes/segments/${hash.slice(0, 2)}/${hash}.json`,
        after: null,
        before: hash,
      }));
    return [
      ...[...this.files].map(([path, after]) => ({
        path,
        after,
        before: this.originals.get(path) === null ? null : digest(this.originals.get(path)!),
      })),
      ...this.index.changes(Object.values(roots)),
      ...obsolete,
      { path: STATE_PATH, after: { schemaVersion: 1, version, roots } },
    ];
  }

  async snapshotRoots() {
    if (!this.changed) return this.state.roots;
    return stateSchema.parse((await this.prepare(this.state.version)).at(-1)!.after).roots;
  }
}
