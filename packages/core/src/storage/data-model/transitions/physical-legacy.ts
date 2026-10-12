/**
 * Составной физический переход legacy → 4 (ТЗ 6.1 «составной переход», R5).
 *
 * Прежняя раскладка репозиториев (`product/`, `boards/`, `task-activity/`, `relations/`,
 * `entity-deletions/`, необязательный `relations.json`) читается только через
 * PhysicalSourceIo, без открытия Workspace и без побочных записей прежних репозиториев.
 * Входные схемы и логика прежних readers заморожены рядом с переходом
 * (history/legacy-readers-4321233.ts и копии функций ниже), текущие декодеры не используются.
 * Выход — дисковая форма dataVersion 1 (Markdown массивами строк) без текущего кодека;
 * её проверяет каталог видов (`validateRecord` схемой версии). Правила преобразования
 * повторяют прежний перенос StorageService.migrate, но детерминированно:
 *
 * - время технических фактов берётся из данных, а не из часов: проект без событий настроек и
 *   созданный паспорт получают самое раннее `createdAt` прежних записей; синхронизированное
 *   управляемое ребро — `updatedAt` записи-владельца, автор `relay`;
 * - ID новых управляемых рёбер — `deterministicId(physical.legacy-to-4, владелец|slot|тип|концы|№)`
 *   с проверкой коллизий; существующие рёбра графа и привязок сохраняют свои ID.
 *
 * Происхождение: c1c353f (самая ранняя раскладка `product/` + `boards/`, задачи version 3) и
 * 5c7265b (последняя legacy: task-activity, entity-deletions, `.document-links`). Раскладка
 * старее c1c353f (отдельные `tasks/` без `product/`) текущими readers не поддерживалась и
 * даёт блокер. Записи выходят в оболочке 3 с dataVersion 1 (в legacy не было планов и релизов).
 *
 * Удаляются по правилу (STORAGE): квитанции графа/удалений/ленты, автоматические события ленты
 * и графа, массивы `events`/`requests` прежних записей, производные индексы. Комментарии ленты
 * переносятся в задачи; файлы с перенесённым содержанием — категория converted-source.
 */
import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { entityAddress } from "@relay/contracts/entities/graph";
import type { EntityRef } from "@relay/contracts/entities/graph";
import type { JsonValue, StoredKeySpace, StoredRecord } from "@relay/contracts/storage";
import { AppError } from "../../../shared/errors.js";
import { digest, jsonValue } from "../../entity-store/format.js";
import { deterministicId } from "../registry.js";
import { relationEntryV1 } from "../history/primitives-43d683b.js";
import type { RelationEntryV1 } from "../history/primitives-43d683b.js";
import {
  legacyActivityEvent,
  legacyActivityMeta,
  legacyActivityReceipt,
  legacyActivitySignal,
  legacyActivitySummary,
  legacyBoard,
  legacyDeletionKeys,
  legacyDeletionReceipt,
  legacyDocumentBindings,
  legacyGraphCurrent,
  legacyGraphMeta,
  legacyGraphReceipt,
  legacyGraphStoredEvent,
  legacyGraphV1,
  legacyImplementation,
  legacyProductId,
  legacyProductRecord,
  legacyProjectSettings,
  legacyScopeManifest,
  legacyTask,
} from "../history/legacy-readers-4321233.js";
import type {
  LegacyBoard,
  LegacyContract,
  LegacyGraphV1,
  LegacyImplementation,
  LegacyProductFields,
  LegacyProjectSettings,
  LegacyStoredEdge,
  LegacyTask,
} from "../history/legacy-readers-4321233.js";
import type {
  PhysicalRemovedSource,
  PhysicalSnapshot,
  PhysicalSourceIo,
  PhysicalTransition,
} from "../types.js";
import {
  Problems,
  count,
  listDir,
  readJsonFile,
  recordAddress,
  sortSnapshot,
} from "./physical-unified.js";

export const PHYSICAL_LEGACY = "physical.legacy-to-4";

const json = (value: unknown): JsonValue => jsonValue(JSON.parse(JSON.stringify(value)));
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const RELAY = "relay";
const EPOCH = "1970-01-01T00:00:00.000Z";
const SERVICE_NAMES = new Set([".gitignore", ".gitkeep", ".DS_Store", "Thumbs.db"]);
const ID8 = /^[A-Za-z0-9]{8}$/;

/* Замороженная логика прежних readers (4321233), не зависящая от текущих модулей. */
type Lines = string[];
type Fields = LegacyProductFields;
type ProductContract = LegacyContract;
type ProductImplementation = Omit<LegacyImplementation, "version">;
type ProductRecord = Omit<ProductImplementation, "fields"> & { fields: Fields };
type Board = LegacyBoard;
type Criterion = Extract<LegacyTask, { acceptanceCriteria: unknown }>["acceptanceCriteria"][number];
type BoardTaskRecord = Omit<
  LegacyTask,
  "version" | "kind" | "productLinks" | "acceptanceCriteria"
> & {
  productLinks: NonNullable<LegacyTask["productLinks"]>;
  acceptanceCriteria: (Omit<Criterion, "summary"> & { summary: string })[];
};
type GraphCurrent = { active: boolean; historyCount: number; edge: LegacyStoredEdge };

/** Каталоги записей продукта (`PRODUCT_DIRECTORIES` product.ts). */
const PRODUCT_DIRECTORIES = {
  passport: "",
  feature: "features",
  scenario: "scenarios",
  application: "applications",
  scope: "scopes",
  document: "documents",
} as const;

/** Markdown версии 1 хранился строкой; кодек версий 2–4 — тот же `split("\n")`. */
const asLines = (value: string | Lines): Lines =>
  Array.isArray(value) ? value : value.split("\n");

function linesFields(fields: Fields): Fields {
  const value = structuredClone(fields) as Record<string, unknown> & { kind: string };
  if ("description" in value) value.description = asLines(value.description as string | Lines);
  if (value.kind === "document") {
    value.body = asLines(value.body as string | Lines);
    if (Array.isArray(value.relations))
      value.relations = value.relations.map((relation: { description: string | Lines }) => ({
        ...relation,
        description: asLines(relation.description),
      }));
  }
  if (value.kind === "scope")
    value.contracts = (value.contracts as { description: string | Lines }[]).map((entry) => ({
      ...entry,
      description: asLines(entry.description),
    }));
  return value as Fields;
}

/** `defaultBoardPrefix` (contracts board.ts, 4321233). */
function defaultBoardPrefix(slug: string): string {
  if (slug === "product") return "PRODUCT";
  if (slug === "infrastructure") return "INFRA";
  const value = slug.replaceAll("-", "").toUpperCase();
  return (/^[A-Z]/.test(value) ? value : `APP${value}`).slice(0, 16).padEnd(2, "X");
}

/** `nextProductKey` (domain/product-addresses.ts, 4321233). */
function nextProductKey(kind: "feature" | "scenario" | "document", records: ProductRecord[]) {
  const prefix = { feature: "FEATURE", scenario: "SCENARIO", document: "DOC" }[kind];
  const pattern = new RegExp(`^${prefix}-[1-9]\\d*$`);
  const maximum = records
    .flatMap((entry) => [entry.key, ...(entry.reservedKeys ?? [])])
    .reduce(
      (max, key) =>
        key && pattern.test(key) ? Math.max(max, Number(key.slice(prefix.length + 1))) : max,
      0,
    );
  return `${prefix}-${maximum + 1}`;
}

/** `defaultProjectName` (storage/project-settings.ts, 4321233). */
function defaultProjectName(configPath: string): string {
  const directory = dirname(configPath);
  return (
    basename(basename(directory) === ".relay" ? dirname(directory) : directory)
      .replace(/\p{Cc}/gu, " ")
      .trim() || "Проект"
  ).slice(0, 120);
}

/** Пути графа v2 (graph-format.ts, 4321233). */
const graphDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const graphShard = (id: string) => graphDigest(id).slice(0, 2);
const eventPath = (sequence: number) =>
  `history/${String(Math.floor((sequence - 1) / 1000)).padStart(12, "0")}/${String(sequence).padStart(16, "0")}.json`;

/** `legacyRecords` (graph-migration.ts, 4321233): текущее состояние графа v1 из событий и рёбер. */
function legacyRecords(legacy: LegacyGraphV1): Map<string, GraphCurrent> {
  const records = new Map<string, GraphCurrent>();
  for (const event of legacy.events) {
    const count = records.get(event.edge.id)?.historyCount ?? 0;
    records.set(event.edge.id, {
      active: event.action !== "remove",
      historyCount: count + 1,
      edge: event.edge,
    });
  }
  const liveIds = new Set(legacy.edges.map((edge) => edge.id));
  for (const record of records.values()) record.active = liveIds.has(record.edge.id);
  for (const edge of legacy.edges)
    records.set(edge.id, {
      active: true,
      historyCount: records.get(edge.id)?.historyCount ?? 0,
      edge,
    });
  return records;
}

type Ctx = {
  io: PhysicalSourceIo;
  owned: () => void;
  problems: Problems;
  removed: Map<string, number>;
  sources: PhysicalRemovedSource[];
};

const source = (ctx: Ctx, path: string, category: string) =>
  ctx.sources.push({ path, area: "config-root", category });

/** Чтение JSON с разбором прежним декодером; ошибка разбора — блокер с путём. */
async function decoded<T>(
  ctx: Ctx,
  path: string,
  decode: (value: unknown) => T,
  maxBytes?: number,
): Promise<T | undefined> {
  const read = await readJsonFile(ctx.io, ctx.owned, ctx.problems, path, "config-root", maxBytes);
  if (read.state === "missing") {
    ctx.problems.add("STORAGE_RECORD_MISSING", "Файл прежней раскладки исчез во время чтения", {
      path,
    });
    return undefined;
  }
  if (read.state !== "ok") return undefined;
  try {
    return decode(read.value);
  } catch (error) {
    if (error instanceof AppError || error instanceof z.ZodError) {
      ctx.problems.add("STORAGE_DATA_CORRUPT", "Файл прежней раскладки не распознан", { path });
      return undefined;
    }
    throw error;
  }
}

function unknownFile(ctx: Ctx, path: string, message = "Неизвестный файл в прежней раскладке") {
  ctx.problems.add("STORAGE_FORMAT_UNKNOWN", message, { path });
}

/** Все файлы поддерева (без служебных), с блокером на symlink и спецфайлы. */
async function tree(ctx: Ctx, path: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await listDir(ctx.io, ctx.owned, path)) {
    const child = `${path}/${entry.name}`;
    if (entry.type === "dir") output.push(...(await tree(ctx, child)));
    else if (entry.type === "other")
      ctx.problems.add("STORAGE_UNSAFE_PATH", "Специальный файл в прежней раскладке", {
        path: child,
      });
    else if (!SERVICE_NAMES.has(entry.name)) output.push(child);
  }
  return output;
}

/* ------------------------------------------------------------------------------------------ */
/* Чтение прежних репозиториев.                                                                */
/* ------------------------------------------------------------------------------------------ */

type ConfigSource = {
  raw: Record<string, JsonValue>;
  projectId: string | undefined;
  storageDir: string;
  settings: LegacyProjectSettings | undefined;
};

const projectIdSchema = z.union([z.string().regex(ID8), z.uuid()]);

async function readConfig(ctx: Ctx): Promise<ConfigSource | undefined> {
  const path = ctx.io.configName;
  const read = await readJsonFile(ctx.io, ctx.owned, ctx.problems, path);
  if (read.state === "missing") {
    ctx.problems.add("STORAGE_RECORD_MISSING", "Файл конфигурации проекта отсутствует", { path });
    return undefined;
  }
  if (read.state !== "ok") return undefined;
  // Текущая схема конфигурации не применяется: читаются только поля раскладки и проекта.
  const shape = z
    .looseObject({
      version: z.literal(1),
      projectId: projectIdSchema.optional(),
      storageDir: z.string().trim().min(1),
      projectSettings: legacyProjectSettings.optional(),
    })
    .safeParse(read.value);
  if (!shape.success) {
    ctx.problems.add("STORAGE_DATA_CORRUPT", "Конфигурация прежнего проекта не распознана", {
      path,
    });
    return undefined;
  }
  return {
    raw: json(read.value) as Record<string, JsonValue>,
    projectId: shape.data.projectId,
    storageDir: shape.data.storageDir,
    settings: shape.data.projectSettings,
  };
}

type ProductSource = {
  records: ProductRecord[];
  implementations: Map<string, ProductImplementation>;
  bindings: Map<string, { owner: EntityRef; slot: string }>;
};

async function readProduct(
  ctx: Ctx,
  productId: string,
  reserved: readonly string[],
): Promise<ProductSource> {
  const records: ProductRecord[] = [];
  const implementations = new Map<string, ProductImplementation>();
  const implementationPaths = new Map<string, string>();
  const bindings = new Map<string, { owner: EntityRef; slot: string }>();
  const recordPaths: string[] = [];
  const known = new Set<string>();

  const readImplementation = async (path: string) => {
    known.add(path);
    const value = await decoded(ctx, path, (raw) => {
      const { version: _version, ...record } = legacyImplementation.parse(raw);
      return record;
    });
    if (value) {
      implementations.set(value.id, value);
      implementationPaths.set(value.id, path);
    }
    return value;
  };
  const decodeRecord = async (path: string, value: unknown): Promise<ProductRecord | undefined> => {
    if (
      typeof value === "object" &&
      value !== null &&
      "storage" in value &&
      value.storage === "references"
    ) {
      const manifest = legacyScopeManifest.safeParse(value);
      if (!manifest.success) {
        ctx.problems.add("STORAGE_DATA_CORRUPT", "Манифест состава не распознан", { path });
        return undefined;
      }
      const appId = manifest.data.fields.applicationId;
      const refs = new Map(manifest.data.fields.contracts.map((ref) => [ref.id, ref]));
      if (refs.size !== manifest.data.fields.contracts.length) {
        ctx.problems.add("STORAGE_DATA_CORRUPT", "Повтор ID реализации в составе", { path });
        return undefined;
      }
      for (const directory of ["features", "scenarios"] as const)
        for (const file of await listDir(
          ctx.io,
          ctx.owned,
          `product/applications/${appId}/${directory}`,
        )) {
          if (file.type !== "file" || !file.name.endsWith(".json")) continue;
          const id = legacyProductId.safeParse(file.name.slice(0, -5));
          if (!id.success) continue;
          const existing = refs.get(id.data);
          if (existing && existing.directory !== directory) {
            ctx.problems.add("STORAGE_DATA_CORRUPT", "ID реализации находится в двух каталогах", {
              path,
            });
            return undefined;
          }
          refs.set(id.data, { id: id.data, directory });
        }
      const contracts: ProductContract[] = [];
      for (const ref of refs.values()) {
        const implPath = `product/applications/${appId}/${ref.directory}/${ref.id}.json`;
        const implementation = await readImplementation(implPath);
        if (!implementation) continue;
        if (
          implementation.id !== ref.id ||
          implementation.productId !== productId ||
          implementation.fields.applicationId !== appId ||
          (implementation.fields.scenarioId === null ? "features" : "scenarios") !== ref.directory
        ) {
          ctx.problems.add("STORAGE_DATA_CORRUPT", "Неверная принадлежность реализации", {
            path: implPath,
          });
          continue;
        }
        const { kind: _kind, applicationId: _app, ...fields } = implementation.fields;
        contracts.push({
          ...fields,
          id: implementation.id,
          ...(implementation.key ? { key: implementation.key } : {}),
          revision: implementation.revision,
        } as ProductContract);
      }
      const { storage: _storage, version: _version, ...record } = manifest.data;
      return { ...record, fields: { ...manifest.data.fields, contracts } as Fields };
    }
    const { version: _version, ...record } = legacyProductRecord.parse(value);
    return { ...record, fields: linesFields(record.fields) };
  };

  const sources: string[] = [];
  for (const directory of Object.values(PRODUCT_DIRECTORIES)) {
    const at = directory ? `product/${directory}` : "product";
    for (const file of await listDir(ctx.io, ctx.owned, at))
      if (file.type === "file" && file.name.endsWith(".json") && !file.name.startsWith("."))
        sources.push(`${at}/${file.name}`);
  }
  for (const app of await listDir(ctx.io, ctx.owned, "product/applications")) {
    if (app.type !== "dir" || !legacyProductId.safeParse(app.name).success) {
      unknownFile(ctx, `product/applications/${app.name}`);
      continue;
    }
    for (const name of ["application.json", "scope.json"]) {
      const path = `product/applications/${app.name}/${name}`;
      if ((await ctx.io.read(path, "config-root")) !== null) sources.push(path);
    }
  }
  for (const path of sources) {
    known.add(path);
    const read = await readJsonFile(ctx.io, ctx.owned, ctx.problems, path);
    if (read.state !== "ok") continue;
    let record: ProductRecord | undefined;
    try {
      record = await decodeRecord(path, read.value);
    } catch (error) {
      if (!(error instanceof AppError) && !(error instanceof z.ZodError)) throw error;
      ctx.problems.add("STORAGE_DATA_CORRUPT", "Запись продукта не распознана", { path });
      continue;
    }
    if (!record) continue;
    const location = path.slice("product/".length);
    const kindDir = PRODUCT_DIRECTORIES[record.fields.kind];
    const canonical =
      record.fields.kind === "application"
        ? `applications/${record.id}/application.json`
        : record.fields.kind === "scope"
          ? `applications/${record.fields.applicationId}/scope.json`
          : record.fields.kind === "passport"
            ? `${record.id}.json`
            : `${kindDir}/${record.id}.json`;
    const allowed = [`${record.id}.json`, `${kindDir}/${record.id}.json`, canonical];
    if (record.productId !== productId || !allowed.includes(location)) {
      ctx.problems.add("STORAGE_DATA_CORRUPT", "Неверная принадлежность записи продукта", {
        path,
      });
      continue;
    }
    if (records.some((entry) => entry.id === record.id)) {
      ctx.problems.add("STORAGE_DATA_CORRUPT", "Дублирующийся ID записи продукта", { path });
      continue;
    }
    records.push(record);
    recordPaths.push(path);
  }
  records.sort((a, b) => byCodePoint(a.id, b.id));

  // Ключи без записи на диске назначаются по правилу прежнего reader (ensureKeys без записи).
  await assignKeys(ctx, records, reserved, implementations);
  for (const record of records)
    if (record.fields.kind === "scope")
      for (const contract of record.fields.contracts) {
        const implementation = implementations.get(contract.id);
        if (implementation && contract.key) implementation.key = contract.key;
      }

  // Привязки прикреплений документов к рёбрам графа.
  for (const file of await listDir(ctx.io, ctx.owned, "product/.document-links")) {
    const path = `product/.document-links/${file.name}`;
    const id = file.name.endsWith(".json") ? file.name.slice(0, -5) : "";
    const owner = records.find((record) => record.id === id && record.fields.kind === "document");
    if (file.type !== "file" || !owner) {
      unknownFile(ctx, path, "Привязки документа без документа или неизвестный файл");
      continue;
    }
    known.add(path);
    const value = await decoded(ctx, path, (raw) => legacyDocumentBindings.parse(raw));
    if (!value) continue;
    for (const binding of Object.values(value.bindings))
      bindings.set(binding.id, { owner: { kind: "document", id }, slot: "document-links" });
    source(ctx, path, "converted-source");
  }

  // Полный перечень файлов product/: всё прочитанное переносится, остальное — блокер.
  for (const path of await tree(ctx, "product")) {
    if (known.has(path)) {
      if (!path.startsWith("product/.document-links/")) source(ctx, path, "converted-source");
      continue;
    }
    if (path === "product/.indexes/catalog.json") source(ctx, path, "derived-index");
    else if (path.startsWith("product/.transactions/"))
      ctx.problems.add("STORAGE_RECOVERY_REQUIRED", "Незавершённая операция прежнего продукта", {
        path,
      });
    else unknownFile(ctx, path);
  }
  for (const record of records) {
    count(ctx.removed, "legacy-record-events", record.events?.length ?? 0);
    count(ctx.removed, "legacy-record-requests", Object.keys(record.requests ?? {}).length);
  }
  for (const record of implementations.values()) {
    count(ctx.removed, "legacy-record-events", record.events?.length ?? 0);
    count(ctx.removed, "legacy-record-requests", Object.keys(record.requests ?? {}).length);
  }
  return { records, implementations, bindings };
}

/** Порт ProductRepository.ensureKeys(persist=false): назначение отсутствующих ключей. */
async function assignKeys(
  ctx: Ctx,
  records: ProductRecord[],
  reserved: readonly string[],
  implementations: ReadonlyMap<string, ProductImplementation>,
): Promise<void> {
  // localeCompare без локали — правило прежнего reader; срабатывает только при записях без ключа.
  const ordered = [...records].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  for (const record of ordered) {
    const kind = record.fields.kind;
    if (
      record.key ||
      !["passport", "feature", "scenario", "application", "document"].includes(kind)
    )
      continue;
    record.key =
      kind === "passport"
        ? "PRODUCT"
        : record.fields.kind === "application"
          ? (record.fields.prefix ?? defaultBoardPrefix(record.fields.slug))
          : nextProductKey(kind as "feature" | "scenario" | "document", records);
  }
  const keys = new Set([
    ...reserved,
    ...records.flatMap((record) => [
      ...(record.key ? [record.key] : []),
      ...(record.fields.kind === "scope"
        ? record.fields.contracts.flatMap((entry) => (entry.key ? [entry.key] : []))
        : []),
    ]),
  ]);
  if (
    records.some(
      (entry) => entry.fields.kind === "scope" && entry.fields.contracts.some((c) => !c.key),
    )
  )
    for (const implementation of implementations.values())
      implementation.reservedKeys?.forEach((key) => keys.add(key));
  for (const record of ordered) {
    if (record.fields.kind !== "scope") continue;
    const appId = record.fields.applicationId;
    const app = records.find((entry) => entry.id === appId);
    for (const contract of record.fields.contracts) {
      if (contract.key) continue;
      const target = records.find(
        (entry) => entry.id === (contract.scenarioId ?? contract.featureId),
      );
      if (!app?.key || !target?.key) {
        ctx.problems.add("STORAGE_REFERENCE_BROKEN", "Не найдена цель реализации без ключа", {
          owner: "implementation",
          id: contract.id,
        });
        continue;
      }
      const applicationPrefix =
        app.fields.kind === "application"
          ? (app.fields.prefix ?? defaultBoardPrefix(app.fields.slug))
          : app.key;
      const prefix = `${applicationPrefix}-${contract.scenarioId === null ? "FI" : "SI"}`;
      const suffix = Number(target.key.split("-").at(-1));
      let number = Number.isSafeInteger(suffix) && suffix > 0 ? suffix : 1;
      while (keys.has(`${prefix}-${number}`)) number++;
      contract.key = `${prefix}-${number}`;
      contract.revision ??= 1;
      keys.add(contract.key);
    }
  }
}

async function readBoards(ctx: Ctx): Promise<{ boards: Board[]; tasks: BoardTaskRecord[] }> {
  const boards: Board[] = [];
  const tasks: BoardTaskRecord[] = [];
  for (const entry of await listDir(ctx.io, ctx.owned, "boards")) {
    const at = `boards/${entry.name}`;
    if (entry.name === ".pending-applications") {
      for (const path of await tree(ctx, at))
        ctx.problems.add(
          "STORAGE_RECOVERY_REQUIRED",
          "Незавершённое создание доски прежнего формата",
          {
            path,
          },
        );
      continue;
    }
    if (SERVICE_NAMES.has(entry.name)) continue;
    if (entry.type !== "dir") {
      unknownFile(ctx, at);
      continue;
    }
    const board = await decoded(ctx, `${at}/board.json`, (raw) => legacyBoard.parse(raw));
    if (!board) continue;
    if (board.slug !== entry.name || boards.some((other) => other.id === board.id)) {
      ctx.problems.add("STORAGE_DATA_CORRUPT", "Slug или ID доски не соответствует каталогу", {
        path: `${at}/board.json`,
      });
      continue;
    }
    boards.push(board);
    source(ctx, `${at}/board.json`, "converted-source");
    count(ctx.removed, "legacy-record-events", board.events?.length ?? 0);
    count(ctx.removed, "legacy-record-requests", Object.keys(board.requests ?? {}).length);
    for (const path of await tree(ctx, at)) {
      if (path === `${at}/board.json`) continue;
      const name = path.slice(`${at}/tasks/`.length);
      if (!path.startsWith(`${at}/tasks/`) || name.includes("/") || !name.endsWith(".json")) {
        unknownFile(ctx, path);
        continue;
      }
      const task = await decoded(
        ctx,
        path,
        (raw) => {
          // Прежний reader: классификация промежуточной итерации отбрасывалась, версии 1–3
          // без поля критериев получают пустой список, пустые summary и productLinks — явно.
          const {
            version: _version,
            kind,
            productLinks,
            ...task
          } = legacyTask.parse(raw) as LegacyTask & { acceptanceCriteria?: Criterion[] };
          if (kind !== undefined) count(ctx.removed, "legacy-task-kind");
          return {
            ...task,
            productLinks: productLinks ?? [],
            acceptanceCriteria: (task.acceptanceCriteria ?? []).map((criterion) => ({
              ...criterion,
              summary: criterion.summary ?? "",
            })),
          } as BoardTaskRecord;
        },
        16 * 1024 * 1024,
      );
      if (!task) continue;
      if (
        name !== `${task.id}.json` ||
        task.boardId !== board.id ||
        tasks.some((t) => t.id === task.id)
      ) {
        ctx.problems.add("STORAGE_DATA_CORRUPT", "Неверная принадлежность задачи доске", { path });
        continue;
      }
      tasks.push(task);
      source(ctx, path, "converted-source");
      count(ctx.removed, "legacy-record-events", task.events?.length ?? 0);
      count(ctx.removed, "legacy-record-requests", Object.keys(task.requests ?? {}).length);
    }
  }
  return {
    boards: boards.sort((a, b) => byCodePoint(a.id, b.id)),
    tasks: tasks.sort((a, b) => byCodePoint(a.id, b.id)),
  };
}

type Activity = {
  /** Задача → максимальный номер ленты. */
  sequences: Map<string, number>;
  comments: Map<string, JsonValue[]>;
  history: Set<string>;
};

async function readActivity(ctx: Ctx): Promise<Activity> {
  const activity: Activity = { sequences: new Map(), comments: new Map(), history: new Set() };
  const bump = (task: string, sequence: number) =>
    activity.sequences.set(task, Math.max(activity.sequences.get(task) ?? 0, sequence));
  for (const path of await tree(ctx, "task-activity")) {
    const rel = path.slice("task-activity/".length);
    if (rel === "signal.json") {
      if (await decoded(ctx, path, (raw) => legacyActivitySignal.parse(raw)))
        source(ctx, path, "task-activity-journal");
      continue;
    }
    if (/^receipts\/[a-f0-9]{64}\.json$/.test(rel)) {
      if (await decoded(ctx, path, (raw) => legacyActivityReceipt.parse(raw)))
        source(ctx, path, "legacy-receipts");
      continue;
    }
    const match =
      /^([A-Za-z0-9]{8})\/(?:(meta)\.json|(events|summaries)\/([1-9]\d{0,14})\.json)$/.exec(rel);
    if (!match) {
      unknownFile(ctx, path);
      continue;
    }
    const task = match[1]!;
    if (match[2]) {
      const meta = await decoded(ctx, path, (raw) => legacyActivityMeta.parse(raw));
      if (!meta) continue;
      activity.history.add(task);
      bump(task, meta.sequence);
      source(ctx, path, "task-activity-journal");
      continue;
    }
    const sequence = Number(match[4]);
    if (match[3] === "summaries") {
      const summary = await decoded(ctx, path, (raw) => legacyActivitySummary.parse(raw));
      if (!summary) continue;
      if (summary.taskId !== task || summary.sequence !== sequence)
        ctx.problems.add("STORAGE_DATA_CORRUPT", "Неверная запись индекса ленты", { path });
      source(ctx, path, "task-activity-journal");
      continue;
    }
    const event = await decoded(
      ctx,
      path,
      (raw) => legacyActivityEvent.parse(raw),
      16 * 1024 * 1024,
    );
    if (!event) continue;
    if (event.taskId !== task || event.id !== String(sequence) || event.sequence !== sequence) {
      ctx.problems.add("STORAGE_DATA_CORRUPT", "Событие принадлежит другой задаче или позиции", {
        path,
      });
      continue;
    }
    bump(task, event.sequence);
    if (event.action === "comment-publish") {
      // Опубликованное сообщение: без изменений полей и с полным текстом.
      if (event.changes.length || event.description === undefined) {
        ctx.problems.add("STORAGE_DATA_CORRUPT", "Комментарий ленты не распознан", { path });
        continue;
      }
      const list = activity.comments.get(task) ?? [];
      list.push(json(event));
      activity.comments.set(task, list);
      source(ctx, path, "converted-source");
    } else {
      count(ctx.removed, "task-activity-events");
      source(ctx, path, "task-activity-journal");
    }
  }
  return activity;
}

type GraphSource = { edges: GraphCurrent[] };

async function readGraph(ctx: Ctx): Promise<GraphSource> {
  const legacyRead = await readJsonFile(
    ctx.io,
    ctx.owned,
    ctx.problems,
    "relations.json",
    "config-root",
    16 * 1024 * 1024,
  );
  const files = await tree(ctx, "relations");
  if (legacyRead.state !== "missing") {
    if (files.some((path) => path === "relations/meta.json"))
      ctx.problems.add("STORAGE_MIGRATION_CONFLICT", "Обнаружены одновременно граф v1 и v2", {
        path: "relations.json",
      });
    if (legacyRead.state !== "ok") return { edges: [] };
    const parsed = legacyGraphV1.safeParse(legacyRead.value);
    if (
      !parsed.success ||
      new Set(parsed.data.edges.map((edge) => edge.id)).size !== parsed.data.edges.length ||
      !parsed.data.edges.every((edge) => edge.source === "graph") ||
      !parsed.data.events.every((event) => event.edge.source === "graph")
    ) {
      ctx.problems.add("STORAGE_DATA_CORRUPT", "Граф v1 не распознан", { path: "relations.json" });
      return { edges: [] };
    }
    count(ctx.removed, "graph-events", parsed.data.events.length);
    count(ctx.removed, "legacy-receipts", Object.keys(parsed.data.requests).length);
    source(ctx, "relations.json", "converted-source");
    for (const path of files) classifyGraphRest(ctx, path, null);
    return { edges: [...legacyRecords(parsed.data).values()] };
  }
  if (!files.length) return { edges: [] };
  const meta = await decoded(ctx, "relations/meta.json", (raw) => legacyGraphMeta.parse(raw));
  if (!meta && !files.includes("relations/meta.json")) {
    if (files.some((path) => path.startsWith("relations/current/")))
      ctx.problems.add(
        "STORAGE_RECORD_MISSING",
        "Метаданные графа потеряны; текущие связи нельзя считать пустой базой",
        { path: "relations/meta.json" },
      );
  } else if (meta) source(ctx, "relations/meta.json", "converted-source");
  const edges: GraphCurrent[] = [];
  const events = new Set<string>();
  if (meta)
    for (let sequence = 1; sequence <= meta.eventCount; sequence++)
      events.add(`relations/${eventPath(sequence)}`);
  for (const path of files) {
    if (path === "relations/meta.json") continue;
    const current = /^relations\/current\/([0-9a-f]{2})\/([^/]+)\.json$/.exec(path);
    if (current) {
      const record = await decoded(ctx, path, (raw) => legacyGraphCurrent.parse(raw));
      if (!record) continue;
      if (
        record.edge.id !== current[2] ||
        graphShard(record.edge.id) !== current[1] ||
        record.edge.source !== "graph"
      ) {
        ctx.problems.add("STORAGE_DATA_CORRUPT", "Неверный ID или источник связи", { path });
        continue;
      }
      edges.push(record);
      source(ctx, path, "converted-source");
      continue;
    }
    if (events.has(path)) {
      if (await decoded(ctx, path, (raw) => legacyGraphStoredEvent.parse(raw))) {
        count(ctx.removed, "graph-events");
        source(ctx, path, "graph-history");
      }
      events.delete(path);
      continue;
    }
    if (/^relations\/requests\/[0-9a-f]{2}\/[a-f0-9]{64}\.json$/.test(path)) {
      if (await decoded(ctx, path, (raw) => legacyGraphReceipt.parse(raw)))
        source(ctx, path, "legacy-receipts");
      continue;
    }
    classifyGraphRest(ctx, path, meta ?? null);
  }
  for (const path of events)
    ctx.problems.add("STORAGE_RECORD_MISSING", "Потеряно событие журнала графа", { path });
  await checkGraphIndex(ctx, edges);
  return { edges: edges.sort((a, b) => byCodePoint(a.edge.id, b.edge.id)) };
}

/** Производный индекс графа и незавершённые транзакции; прочее — блокер. */
function classifyGraphRest(ctx: Ctx, path: string, _meta: unknown): void {
  if (path.startsWith("relations/.indexes/")) source(ctx, path, "derived-index");
  else if (path.startsWith("relations/transactions/"))
    ctx.problems.add("STORAGE_RECOVERY_REQUIRED", "Незавершённая транзакция прежнего графа", {
      path,
    });
  else unknownFile(ctx, path);
}

/** Производный индекс графа обнаруживает потерю текущих файлов связей. */
async function checkGraphIndex(ctx: Ctx, edges: readonly GraphCurrent[]): Promise<void> {
  const header = await ctx.io.read("relations/.indexes/edges.json", "config-root");
  if (!header) return;
  let shards: string[];
  try {
    const parsed = z
      .looseObject({ shards: z.record(z.string().regex(/^[a-f0-9]{2}$/), z.unknown()) })
      .parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(header)));
    shards = Object.keys(parsed.shards);
  } catch {
    return;
  }
  const present = new Set(edges.map((record) => record.edge.id));
  for (const shard of shards.sort()) {
    const bytes = await ctx.io.read(`relations/.indexes/edges/${shard}.json`, "config-root");
    if (!bytes) continue;
    try {
      const parsed = z
        .looseObject({ entries: z.array(z.looseObject({ id: z.string() })) })
        .parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      for (const entry of parsed.entries)
        if (!present.has(entry.id))
          ctx.problems.add("STORAGE_RECORD_MISSING", "Потерян текущий файл связи графа", {
            id: entry.id,
            path: `relations/current/${graphShard(entry.id)}/${entry.id}.json`,
          });
    } catch {
      return;
    }
  }
}

async function readDeletions(ctx: Ctx): Promise<string[]> {
  let keys: string[] = [];
  for (const path of await tree(ctx, "entity-deletions")) {
    if (path === "entity-deletions/keys.json") {
      const value = await decoded(
        ctx,
        path,
        (raw) => legacyDeletionKeys.parse(raw),
        16 * 1024 * 1024,
      );
      if (!value) continue;
      keys = value;
      source(ctx, path, "converted-source");
    } else if (/^entity-deletions\/receipts\/[a-f0-9]{64}\.json$/.test(path)) {
      if (await decoded(ctx, path, (raw) => legacyDeletionReceipt.parse(raw)))
        source(ctx, path, "legacy-receipts");
    } else if (path === "entity-deletions/pending.json")
      ctx.problems.add("STORAGE_RECOVERY_REQUIRED", "Незавершённое удаление прежнего формата", {
        path,
      });
    else unknownFile(ctx, path);
  }
  return keys;
}

/* ------------------------------------------------------------------------------------------ */
/* Преобразование в записи формата 4.                                                          */
/* ------------------------------------------------------------------------------------------ */

type Meta = {
  id: string;
  revision: number;
  key?: string | null | undefined;
  createdAt: string;
  createdBy: string;
  updatedAt?: string | undefined;
  updatedBy?: string | undefined;
  reservedKeys?: string[] | undefined;
  aliases?: string[] | undefined;
};

/**
 * Порт unified-adapter.metadata: оболочка 3 прежней записи без событий и квитанций.
 * Данные уже в дисковой форме dataVersion 1 (Markdown строками), без текущего кодека;
 * соответствие схеме версии проверяет каталог видов (`validateRecord`).
 */
type Draft = Extract<StoredRecord, { data: unknown }> & Record<string, unknown>;
function metadata(record: Meta, kind: string, data: Record<string, unknown>): Draft {
  return {
    schemaVersion: 3,
    dataVersion: 1,
    kind,
    id: record.id,
    revision: record.revision,
    key: record.key ?? null,
    aliases: record.reservedKeys ?? record.aliases ?? [],
    data: json(data) as Record<string, JsonValue>,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    updatedAt: record.updatedAt ?? record.createdAt,
    updatedBy: record.updatedBy ?? record.createdBy,
  };
}

type Desired = { type: string; from: EntityRef; to: EntityRef; description: string };
const signature = (edge: Pick<Desired, "type" | "from" | "to">) =>
  JSON.stringify([edge.type, entityAddress(edge.from), entityAddress(edge.to)]);

class Relations {
  readonly sets = new Map<string, { owner: EntityRef; entries: RelationEntryV1[] }>();
  readonly ids = new Map<string, string>();
  constructor(readonly ctx: Ctx) {}
  set(owner: EntityRef) {
    const key = recordAddress(owner);
    let set = this.sets.get(key);
    if (!set) this.sets.set(key, (set = { owner, entries: [] }));
    return set;
  }
  /** Порт writeOwnedRelations: ребро сохраняет свой ID, владельца и назначение. */
  write(owner: EntityRef, entry: RelationEntryV1): void {
    const prior = this.ids.get(entry.edge.id);
    if (prior !== undefined && prior !== recordAddress(owner)) {
      this.ctx.problems.add("STORAGE_MIGRATION_CONFLICT", "ID связи занят другим владельцем", {
        id: entry.edge.id,
      });
      return;
    }
    const set = this.set(owner);
    const index = set.entries.findIndex((item) => item.edge.id === entry.edge.id);
    if (index >= 0) {
      const before = set.entries[index]!;
      if (before.slot !== entry.slot || signature(before.edge) !== signature(entry.edge)) {
        this.ctx.problems.add("STORAGE_MIGRATION_CONFLICT", "ID связи передан другому назначению", {
          id: entry.edge.id,
        });
        return;
      }
      set.entries[index] = entry;
    } else set.entries.push(entry);
    this.ids.set(entry.edge.id, recordAddress(owner));
  }
  /**
   * Порт replaceOwnedRelations с детерминированным временем и ID: совпавшие по типу и концам
   * активные рёбра группы сохраняются, лишние отзываются, недостающие создаются.
   */
  replace(owner: EntityRef, slot: string, desired: readonly Desired[], at: string): void {
    const set = this.set(owner);
    const candidates = new Map<string, RelationEntryV1[]>();
    for (const entry of set.entries)
      if (entry.slot === slot && entry.edge.active) {
        const group = candidates.get(signature(entry.edge)) ?? [];
        group.push(entry);
        candidates.set(signature(entry.edge), group);
      }
    const positions = new Map<string, number>();
    const used = new Set<string>();
    const occurrences = new Map<string, number>();
    for (const input of desired) {
      const key = signature(input);
      const group = candidates.get(key) ?? [];
      let position = positions.get(key) ?? 0;
      while (position < group.length && used.has(group[position]!.edge.id)) position++;
      let entry = group[position];
      positions.set(key, position + 1);
      if (entry) {
        if (entry.edge.description.join("\n") !== input.description) {
          entry.edge.description = input.description.split("\n");
          entry.edge.historyCount = (entry.edge.historyCount ?? entry.edge.revision) + 1;
          entry.edge.revision++;
          entry.edge.updatedAt = at;
          entry.edge.updatedBy = RELAY;
        }
      } else {
        const occurrence = (occurrences.get(key) ?? 0) + 1;
        occurrences.set(key, occurrence);
        const id = deterministicId(
          PHYSICAL_LEGACY,
          `${entityAddress(owner)}|${slot}|${key}|${occurrence}`,
        );
        if (this.ids.has(id)) {
          this.ctx.problems.add(
            "STORAGE_ADDRESS_COLLISION",
            "Детерминированный ID связи уже занят",
            {
              id,
            },
          );
          continue;
        }
        entry = {
          slot,
          edge: {
            id,
            type: input.type,
            from: input.from,
            to: input.to,
            description: input.description.split("\n"),
            revision: 1,
            source: "graph",
            createdAt: at,
            createdBy: RELAY,
            active: true,
            updatedAt: at,
            updatedBy: RELAY,
          },
        };
        set.entries.push(entry);
        this.ids.set(id, recordAddress(owner));
      }
      used.add(entry.edge.id);
    }
    for (const entry of set.entries)
      if (entry.slot === slot && entry.edge.active && !used.has(entry.edge.id)) {
        entry.edge.active = false;
        entry.edge.historyCount = (entry.edge.historyCount ?? entry.edge.revision) + 1;
        entry.edge.revision++;
        entry.edge.updatedAt = at;
        entry.edge.updatedBy = RELAY;
      }
  }
}

/** Чистое чтение legacy-раскладки в снимок формата 4. */
export async function readLegacySnapshot(
  io: PhysicalSourceIo,
  owned: () => void,
): Promise<PhysicalSnapshot> {
  const problems = new Problems();
  const ctx: Ctx = { io, owned, problems, removed: new Map(), sources: [] };
  const config = await readConfig(ctx);
  problems.throwIfAny(PHYSICAL_LEGACY);
  const { raw, projectId, settings } = config!;
  const root = dirname(io.configPath);
  const productId =
    projectId && ID8.test(projectId)
      ? projectId
      : `product_${createHash("sha256")
          .update(projectId ?? resolve(root, config!.storageDir))
          .digest("hex")
          .slice(0, 32)}`;

  // Каталоги раскладки старее c1c353f и журналы единого формата в legacy не поддерживаются.
  const storageTop = config!.storageDir.split(/[\\/]/)[0];
  for (const top of new Set(["tasks", "operations", "history", storageTop])) {
    if (!top || top === "." || top === "..") continue;
    for (const path of await tree(ctx, top))
      if (!path.startsWith(`${top}/runtime/`) && !path.startsWith("runtime/"))
        unknownFile(ctx, path, "Файл раскладки, которую прежние readers не поддерживали");
  }
  if ((await io.read("kanban-pending.json", "config-root")) !== null)
    problems.add("STORAGE_RECOVERY_REQUIRED", "Незавершённая операция задач прежнего формата", {
      path: "kanban-pending.json",
    });

  const reserved = await readDeletions(ctx);
  const product = await readProduct(ctx, productId, reserved);
  const { boards, tasks } = await readBoards(ctx);
  const activity = await readActivity(ctx);
  const graph = await readGraph(ctx);
  problems.throwIfAny(PHYSICAL_LEGACY);

  const records = new Map<string, Draft>();
  const put = (record: Draft) => {
    const address = `${record.kind}:${record.id}`;
    const prior = records.get(address);
    if (prior && digest(json(prior)) !== digest(json(record))) {
      problems.add("STORAGE_MIGRATION_CONFLICT", "Целевая запись уже отличается от переносимой", {
        owner: record.kind,
        id: record.id,
      });
      return;
    }
    records.set(address, record);
  };
  const times = [
    ...product.records.map((record) => record.createdAt),
    ...[...product.implementations.values()].map((record) => record.createdAt),
    ...boards.map((board) => board.createdAt),
    ...tasks.map((task) => task.createdAt),
  ].sort(byCodePoint);
  const earliest = times[0] ?? EPOCH;

  // Проект: настройки из конфигурации; без событий — самое раннее время прежних записей.
  const projectRef = { kind: "project", id: projectId ?? "project" };
  const value = settings ?? {
    version: 1 as const,
    name: defaultProjectName(io.configPath),
    slug: `project-${createHash("sha256")
      .update(projectId ?? io.configPath)
      .digest("hex")
      .slice(0, 4)}`,
    revision: 0,
  };
  if (settings) {
    count(ctx.removed, "legacy-record-events", settings.events?.length ?? 0);
    count(ctx.removed, "legacy-record-requests", Object.keys(settings.requests ?? {}).length);
  }
  const event = value.events?.at(-1);
  const projectAt = event?.at ?? earliest;
  put({
    schemaVersion: 3,
    dataVersion: 1,
    kind: "project",
    id: projectRef.id,
    key: value.entityKey ?? "PROJECT",
    aliases: value.aliases ?? [],
    revision: value.revision,
    createdAt: projectAt,
    createdBy: RELAY,
    updatedAt: projectAt,
    updatedBy: event?.actor ?? RELAY,
    data: {
      name: value.name,
      slug: value.slug,
      ...(value.documentSections ? { documentSections: value.documentSections } : {}),
    },
  });
  if (!product.records.some((record) => record.fields.kind === "passport"))
    put({
      schemaVersion: 3,
      dataVersion: 1,
      kind: "product",
      id: "passport",
      key: "PRODUCT",
      aliases: [],
      revision: 0,
      data: { name: "", summary: "", description: [""] },
      createdAt: earliest,
      createdBy: RELAY,
      updatedAt: earliest,
      updatedBy: RELAY,
    });
  for (const record of product.records) {
    if (record.fields.kind === "scope") continue;
    const { kind: _kind, ...data } = record.fields as Record<string, unknown>;
    if (record.fields.kind === "application") delete data.prefix;
    put(metadata(record, record.fields.kind === "passport" ? "product" : record.fields.kind, data));
  }
  const keyspaces = new Map<string, StoredKeySpace>();
  const saveKeySpace = (space: StoredKeySpace) => {
    const prior = keyspaces.get(space.id);
    if (prior && digest(json(prior)) !== digest(json(space)))
      problems.add("STORAGE_MIGRATION_CONFLICT", "Пространство ключей объявлено по-разному", {
        id: space.id,
      });
    keyspaces.set(space.id, space);
  };
  for (const board of boards) {
    const prefix = board.prefix ?? defaultBoardPrefix(board.slug);
    put(
      metadata(
        {
          ...board,
          key: board.key ?? `BOARD-${prefix}`,
          updatedAt: board.events?.at(-1)?.at ?? board.createdAt,
          updatedBy: board.events?.at(-1)?.actor ?? board.createdBy,
        },
        "board",
        { slug: board.slug, scope: board.kind, applicationId: board.applicationId },
      ),
    );
    saveKeySpace({
      schemaVersion: 1,
      id: board.id,
      entityKind: "task",
      owner: { kind: "board", id: board.id },
      prefix,
      format: "{prefix}-{number}",
    });
    if (board.applicationId)
      for (const suffix of ["fi", "si"])
        saveKeySpace({
          schemaVersion: 1,
          id: `${board.applicationId}-${suffix}`,
          entityKind: "implementation",
          owner: { kind: "application", id: board.applicationId },
          prefix: `${prefix}-${suffix.toUpperCase()}`,
          format: "{prefix}-{number}",
        });
  }
  for (const implementation of [...product.implementations.values()].sort((a, b) =>
    byCodePoint(a.id, b.id),
  )) {
    const { kind: _kind, ...data } = implementation.fields;
    put(metadata(implementation, "implementation", data));
  }
  for (const record of product.records) {
    if (record.fields.kind !== "scope") continue;
    const applicationId = record.fields.applicationId;
    for (const contract of record.fields.contracts) {
      const previous = product.implementations.get(contract.id);
      const { id, key, revision: _revision, ...fields } = contract;
      const nextFields = { ...fields, kind: "implementation" as const, applicationId };
      if (previous) {
        if (digest(json(previous.fields)) !== digest(json(nextFields)))
          problems.add(
            "STORAGE_MIGRATION_CONFLICT",
            "Состав приложения расходится с отдельной реализацией",
            { owner: "implementation", id },
          );
        continue;
      }
      // Состав без отдельного файла (прежнее встроенное хранение): реализация из состава.
      const { kind: _k, ...data } = nextFields;
      put(
        metadata(
          {
            id,
            key: key ?? null,
            revision: contract.revision ?? 1,
            createdAt: record.createdAt,
            createdBy: record.createdBy,
            updatedAt: record.updatedAt,
            updatedBy: record.updatedBy,
            reservedKeys: [],
          },
          "implementation",
          data,
        ),
      );
    }
    put(
      metadata(record, "scope", {
        applicationId,
        implementations: record.fields.contracts.map((entry) => entry.id),
      }),
    );
  }
  for (const task of tasks) {
    const {
      id,
      key,
      keys,
      revision,
      createdAt,
      createdBy,
      updatedAt,
      updatedBy,
      events: _events,
      requests: _requests,
      ...data
    } = task;
    put(
      metadata(
        {
          id,
          key,
          revision,
          createdAt,
          createdBy,
          updatedAt,
          updatedBy,
          aliases: keys.filter((alias) => alias !== key),
        },
        "task",
        data,
      ),
    );
  }
  for (const [kind, prefix] of [
    ["feature", "FEATURE"],
    ["scenario", "SCENARIO"],
    ["document", "DOC"],
  ] as const)
    saveKeySpace({
      schemaVersion: 1,
      id: `global-${kind}`,
      entityKind: kind,
      owner: projectRef,
      prefix,
      format: "{prefix}-{number}",
    });

  const stored = records;
  problems.throwIfAny(PHYSICAL_LEGACY);

  // Резервы удалённых адресов принадлежат проекту.
  const project = stored.get(recordAddress(projectRef))!;
  if (reserved.length)
    project.reservedKeys = [...new Set([...(project.reservedKeys ?? []), ...reserved])];
  // Лента: комментарии и последовательность; без ленты — номера прежних событий записи.
  const taskIds = new Set(tasks.map((task) => task.id));
  for (const task of [...activity.sequences.keys(), ...activity.comments.keys()])
    if (!taskIds.has(task))
      problems.add("STORAGE_REFERENCE_BROKEN", "Лента задачи без задачи", {
        owner: "task",
        id: task,
        path: `task-activity/${task}`,
      });
  for (const task of tasks) {
    const record = stored.get(`task:${task.id}`)!;
    const sequence = activity.history.has(task.id)
      ? (activity.sequences.get(task.id) ?? 0)
      : Math.max(task.events?.length ?? 0, activity.sequences.get(task.id) ?? 0);
    const comments = [...(activity.comments.get(task.id) ?? [])].sort(
      (a, b) => (a as { sequence: number }).sequence - (b as { sequence: number }).sequence,
    );
    if (comments.length) record.comments = comments as never;
    if (sequence > 0) record.commentSequence = sequence;
  }

  // Отношения: рёбра графа с их ID, затем управляемые группы по правилам Core.
  const relations = new Relations(ctx);
  for (const current of graph.edges) {
    const binding = product.bindings.get(current.edge.id) ?? {
      owner: current.edge.from,
      slot: "diagnostic",
    };
    const entry = relationEntryV1.safeParse({
      slot: binding.slot,
      edge: {
        ...current.edge,
        active: current.active,
        historyCount: current.historyCount,
        updatedAt: current.edge.createdAt,
        updatedBy: current.edge.createdBy,
      },
    });
    if (!entry.success) {
      problems.add("STORAGE_DATA_CORRUPT", "Связь графа не распознана", { id: current.edge.id });
      continue;
    }
    relations.write(binding.owner, entry.data);
  }
  syncManaged(relations, stored, product, boards, tasks, projectRef);

  // Проверка: активные рёбра ссылаются на существующие записи.
  for (const set of relations.sets.values()) {
    if (!stored.has(recordAddress(set.owner)))
      problems.add("STORAGE_REFERENCE_BROKEN", "Владелец набора связей отсутствует", {
        owner: set.owner.kind,
        id: set.owner.id,
      });
    for (const entry of set.entries)
      if (entry.edge.active)
        for (const ref of [entry.edge.from, entry.edge.to])
          if (!stored.has(recordAddress(ref)))
            problems.add(
              "STORAGE_REFERENCE_BROKEN",
              "Активная связь ссылается на отсутствующую сущность",
              {
                id: entry.edge.id,
              },
            );
  }
  const output: StoredRecord[] = [];
  for (const [address, record] of stored)
    try {
      output.push(io.catalog.validateRecord(record));
    } catch (error) {
      const [kind, ...rest] = address.split(":");
      problems.addError(error, { owner: kind!, id: rest.join(":") });
    }
  problems.throwIfAny(PHYSICAL_LEGACY);

  const { projectSettings: _settings, ...configValue } = raw;
  return sortSnapshot({
    records: output,
    relations: [...relations.sets.values()].map((set) => ({
      owner: set.owner,
      value: {
        schemaVersion: 1,
        owner: set.owner,
        storage: "inline",
        entries: [...set.entries]
          .sort((a, b) => byCodePoint(a.edge.id, b.edge.id))
          .map((entry) => json(entry)),
      },
    })),
    keyspaces: [...keyspaces.values()],
    config: json(configValue),
    productId,
    removeSources: ctx.sources,
    removed: ctx.removed,
  });
}

/** Управляемые группы связей прежнего переноса (owned-relations.ts) в том же порядке. */
function syncManaged(
  relations: Relations,
  stored: ReadonlyMap<string, StoredRecord>,
  product: ProductSource,
  boards: readonly Board[],
  tasks: readonly BoardTaskRecord[],
  projectRef: EntityRef,
): void {
  const at = (ref: EntityRef) => {
    const record = stored.get(recordAddress(ref));
    return record && "updatedAt" in record ? record.updatedAt : EPOCH;
  };
  const passport = { kind: "product", id: "passport" };
  const root = () =>
    relations.replace(
      passport,
      "product-links",
      [{ type: "part-of", from: passport, to: projectRef, description: "" }],
      at(passport),
    );
  const board = (entry: Board) => {
    const owner = { kind: "board", id: entry.id };
    relations.replace(
      owner,
      "board-links",
      entry.applicationId
        ? [
            {
              type: "part-of",
              from: owner,
              to: { kind: "application", id: entry.applicationId },
              description: "",
            },
          ]
        : [],
      at(owner),
    );
  };
  root();
  for (const entry of boards) board(entry);
  for (const record of product.records) {
    const fields = record.fields;
    if (fields.kind === "passport" || fields.kind === "feature") root();
    if (fields.kind === "feature") {
      const owner = { kind: "feature", id: record.id };
      relations.replace(
        owner,
        "feature-links",
        [{ type: "part-of", from: owner, to: passport, description: "" }],
        at(owner),
      );
    } else if (fields.kind === "scenario") {
      const owner = { kind: "scenario", id: record.id };
      relations.replace(
        owner,
        "scenario-links",
        [
          {
            type: "part-of",
            from: owner,
            to: { kind: "feature", id: fields.featureId },
            description: "",
          },
        ],
        at(owner),
      );
    } else if (fields.kind === "document") {
      const owner = { kind: "document", id: record.id };
      relations.replace(
        owner,
        "document-links",
        [
          ...fields.links.map((link) => ({
            type: "documents",
            from: owner,
            to: { kind: link.kind, id: link.kind === "product" ? "passport" : link.id },
            description: "",
          })),
          ...(fields.relations ?? []).map((link) => ({
            type: link.type,
            from: link.type === "references" ? link.target : owner,
            to: link.type === "references" ? owner : link.target,
            description: asLines(link.description).join("\n"),
          })),
        ],
        at(owner),
      );
    } else if (fields.kind === "scope") {
      for (const contract of fields.contracts) {
        const owner = { kind: "implementation", id: contract.id };
        let parentId: string | undefined;
        if (contract.scenarioId !== null) {
          parentId = fields.contracts.find(
            (entry) => entry.featureId === contract.featureId && entry.scenarioId === null,
          )?.id;
          if (!parentId && contract.active !== false) {
            relations.ctx.problems.add(
              "STORAGE_REFERENCE_BROKEN",
              "У активной сценарной реализации отсутствует реализация фичи",
              { owner: "implementation", id: contract.id },
            );
            continue;
          }
        }
        relations.replace(
          owner,
          "implementation-links",
          [
            {
              type: "part-of",
              from: owner,
              to: { kind: "application", id: fields.applicationId },
              description: "",
            },
            {
              type: "implements",
              from: owner,
              to: contract.scenarioId
                ? { kind: "scenario", id: contract.scenarioId }
                : { kind: "feature", id: contract.featureId },
              description: "",
            },
            ...(parentId
              ? [
                  {
                    type: "part-of",
                    from: owner,
                    to: { kind: "implementation", id: parentId },
                    description: "",
                  },
                ]
              : []),
          ],
          at(owner),
        );
      }
    } else if (fields.kind === "application")
      for (const entry of boards.filter((item) => item.applicationId === record.id)) board(entry);
  }
  for (const task of tasks) {
    const owner = { kind: "task", id: task.id };
    relations.replace(
      owner,
      "task-links",
      [
        { type: "part-of", from: owner, to: { kind: "board", id: task.boardId }, description: "" },
        ...task.productLinks.map((to) => ({
          type: "implements",
          from: owner,
          to,
          description: "",
        })),
        ...task.dependencies.map((id) => ({
          type: "depends-on",
          from: owner,
          to: { kind: "task", id },
          description: "",
        })),
        ...task.related.map((id) => ({
          type: "related",
          from: owner,
          to: { kind: "task", id },
          description: "",
        })),
        ...(task.parentId
          ? [
              {
                type: "part-of",
                from: owner,
                to: { kind: "task", id: task.parentId },
                description: "",
              },
            ]
          : []),
      ],
      at(owner),
    );
  }
}

export const physicalLegacy: PhysicalTransition = Object.freeze({
  type: "physical" as const,
  id: PHYSICAL_LEGACY,
  version: 1,
  description:
    "Прежние репозитории (c1c353f…5c7265b) → формат 4: записи, комментарии ленты, связи графа и привязки; квитанции и журналы удаляются",
  from: "legacy" as const,
  to: "unified-4" as const,
  read: (io: PhysicalSourceIo, owned: () => void) => readLegacySnapshot(io, owned),
});
