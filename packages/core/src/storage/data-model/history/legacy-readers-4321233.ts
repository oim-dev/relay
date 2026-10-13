/**
 * Замороженные дисковые схемы legacy-раскладки (до единого хранилища) — вход перехода
 * `physical.legacy-to-4`.
 *
 * Происхождение: прежние readers на исследованной базе 4321233 (последнее объявление
 * поддержки legacy), которые принимали раскладки c1c353f…5c7265b:
 * `git show 4321233:packages/contracts/src/entities/{product,product-implementation,board,
 * board-task,task-acceptance,project-settings,document-library,graph}.ts`,
 * `git show 4321233:packages/contracts/src/entities.ts` (`entityDeletedSchema`),
 * `git show 4321233:packages/core/src/domain/legacy-records.ts` (аудит записей),
 * `git show 4321233:packages/core/src/storage/{product,product-codec,board-tasks,task-activity,
 * document-links,graph-format,entity-deletion}.ts`, `.../storage/legacy/{task-activity,graph-event}.ts`.
 * Фикстуры: `test/fixtures/data-migrations/legacy-c1c353f`, `legacy-5c7265b`.
 *
 * Схемы копируются, а не импортируются: текущие схемы Contracts/Core могут меняться.
 * Нет `.default()`, `.transform()`, `.trim()`-pipe и удаления неизвестных ключей: прежние
 * значения по умолчанию (`productLinks: []`, пустые `summary`/`description` критерия, пустые
 * критерии задач версий 1–3) применяет сам переход явно. Markdown остаётся массивом строк.
 */
import { z } from "zod";
import {
  actor,
  entityRef,
  markdownLines,
  singleLine,
  text,
  timestamp,
} from "./primitives-43d683b.js";

const lines = z.array(z.string().refine((line) => !line.includes("\n")));
/** `markdown` продукта: непустой после trim текст до 256 КиБ. */
const productMarkdown = markdownLines(256 * 1024).refine(
  (value) => value.join("\n").trim().length > 0,
  "Markdown не должен быть пустым",
);
const token = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const legacyEntityKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/);
const requestId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const legacyProductId = z
  .string()
  .regex(
    /^(?:[A-Za-z0-9]{8}|passport|(?:feature|scenario|application|scope|document|contract)_[a-f0-9]{32})$/,
  );
const taskId = z.string().regex(/^[A-Za-z0-9]{8}$/);
const taskReference = z
  .string()
  .min(1)
  .max(257)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const boardSlug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const boardPrefix = z.string().regex(/^[A-Z][A-Z0-9]{1,15}$/);
const positive = z.number().int().positive();

/* Аудит прежних записей (domain/legacy-records.ts): удаляется переходом по правилу. */
const productEvent = z.strictObject({ revision: positive, actor, at: timestamp });
const recordEvent = productEvent.extend({ action: z.string() });
const savedReceipt = z.strictObject({
  hash: z.string(),
  result: z.strictObject({
    id: z.string(),
    key: z.string().optional(),
    revision: z.number().int().nonnegative(),
  }),
});
const productAudit = {
  events: z.array(productEvent),
  requests: z.record(z.string(), savedReceipt),
};

/* Продукт (product.ts / product-codec.ts). */
const title = singleLine(1024);
const productStatus = z.enum(["none", "partial", "done"]);
const productReference = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("product") }),
  z.strictObject({ kind: z.literal("feature"), id: legacyProductId }),
  z.strictObject({ kind: z.literal("scenario"), id: legacyProductId }),
  z.strictObject({ kind: z.literal("application"), id: legacyProductId }),
  z.strictObject({
    kind: z.literal("implementation"),
    applicationId: legacyProductId,
    id: legacyProductId,
  }),
]);
const documentSectionId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
function productFieldsOf(
  markdown: z.ZodType<string[] | string>,
  relationText: z.ZodType<string[] | string>,
) {
  const contract = z.strictObject({
    featureId: legacyProductId,
    scenarioId: legacyProductId.nullable(),
    title,
    description: markdown,
    status: productStatus,
    id: legacyProductId,
    key: legacyEntityKey.optional(),
    revision: positive.optional(),
    active: z.boolean(),
    basis: z.string(),
  });
  const documentRelation = z.strictObject({
    target: z.strictObject({
      kind: z.enum([
        "project",
        "product",
        "feature",
        "scenario",
        "application",
        "implementation",
        "board",
        "task",
        "document",
        "work-plan",
        "release",
      ]),
      id: token,
    }),
    type: z.enum(["references", "documents"]),
    description: relationText,
  });
  const documentRelations = z
    .array(documentRelation)
    .max(100)
    .refine(
      (links) =>
        new Set(links.map((link) => `${link.target.kind}:${link.target.id}:${link.type}`)).size ===
        links.length,
      "Повтор отношения документа",
    );
  return z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("passport"),
      name: title,
      summary: text(4096),
      description: markdown,
    }),
    z.strictObject({
      kind: z.literal("feature"),
      name: title,
      summary: text(4096),
      description: markdown,
    }),
    z.strictObject({
      kind: z.literal("scenario"),
      featureId: legacyProductId,
      name: title,
      description: markdown,
    }),
    z.strictObject({
      kind: z.literal("application"),
      name: title,
      summary: text(4096),
      description: markdown,
      slug: boardSlug.refine((slug) => !["product", "infrastructure", "new"].includes(slug)),
      prefix: boardPrefix.optional(),
      type: z.enum(["frontend", "backend", "internal"]),
    }),
    z.strictObject({
      kind: z.literal("scope"),
      applicationId: legacyProductId,
      contracts: z.array(contract).max(10000),
    }),
    z.strictObject({
      kind: z.literal("document"),
      name: title,
      summary: text(4096),
      body: markdown,
      documentKind: z.enum([
        "specification",
        "description",
        "rules",
        "instruction",
        "proposal",
        "decision",
        "research",
      ]),
      sectionId: documentSectionId.nullable().optional(),
      documentStatus: z.enum(["draft", "active", "archived"]).optional(),
      relations: documentRelations.optional(),
      pinned: z.boolean().optional(),
      links: z.array(productReference).max(1000),
    }),
  ]);
}
export const legacyProductFields = productFieldsOf(productMarkdown, markdownLines(16 * 1024));
/** Версия 1: Markdown строкой (productRecordSchema без кодека). */
const legacyProductFieldsV1 = productFieldsOf(
  text(256 * 1024).refine((value) => value.trim().length > 0),
  text(16 * 1024),
);
const contract = z.strictObject({
  featureId: legacyProductId,
  scenarioId: legacyProductId.nullable(),
  title,
  description: productMarkdown,
  status: productStatus,
  id: legacyProductId,
  key: legacyEntityKey.optional(),
  revision: positive.optional(),
  active: z.boolean(),
  basis: z.string(),
});
const productMeta = {
  productId: z.string().min(1),
  id: legacyProductId,
  key: legacyEntityKey.optional(),
  reservedKeys: z.array(legacyEntityKey).optional(),
  revision: positive,
  createdAt: timestamp,
  updatedAt: timestamp,
  createdBy: actor,
  updatedBy: actor,
  ...productAudit,
};
/** Запись продукта версий 2/3/4 (документы — 4, остальные — 3): Markdown строками. */
export const legacyProductRecord = z.union([
  z.strictObject({
    version: z.union([z.literal(2), z.literal(3), z.literal(4)]),
    ...productMeta,
    fields: legacyProductFields,
  }),
  z.strictObject({ version: z.literal(1), ...productMeta, fields: legacyProductFieldsV1 }),
]);
/** Манифест состава приложения со ссылками на отдельные реализации. */
export const legacyScopeManifest = z.strictObject({
  version: z.literal(3),
  storage: z.literal("references"),
  ...productMeta,
  fields: z.strictObject({
    kind: z.literal("scope"),
    applicationId: legacyProductId,
    contracts: z.array(
      z.strictObject({ id: legacyProductId, directory: z.enum(["features", "scenarios"]) }),
    ),
  }),
});
/** Отдельная реализация `applications/<app>/{features,scenarios}/<id>.json`, версия 3. */
export const legacyImplementation = z.strictObject({
  version: z.literal(3),
  ...productMeta,
  fields: z.strictObject({
    featureId: legacyProductId,
    scenarioId: legacyProductId.nullable(),
    title,
    description: productMarkdown,
    status: productStatus,
    active: z.boolean(),
    basis: z.string(),
    kind: z.literal("implementation"),
    applicationId: legacyProductId,
  }),
});
export type LegacyProductRecord = z.output<typeof legacyProductRecord>;
export type LegacyProductFields = z.output<typeof legacyProductFields>;
export type LegacyContract = z.output<typeof contract>;
export type LegacyImplementation = z.output<typeof legacyImplementation>;

/* Доски и задачи (board.ts, board-task.ts, task-acceptance.ts, board-tasks.ts). */
export const legacyBoard = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]),
  id: z.string().regex(/^(?:[A-Za-z0-9]{8}|board_(?:product|infrastructure|[a-f0-9]{32}))$/),
  slug: boardSlug,
  prefix: boardPrefix.optional(),
  key: legacyEntityKey.optional(),
  aliases: z.array(legacyEntityKey).optional(),
  kind: z.enum(["product", "application", "infrastructure"]),
  applicationId: z
    .string()
    .regex(/^(?:[A-Za-z0-9]{8}|application_[a-f0-9]{32})$/)
    .nullable(),
  revision: positive,
  createdAt: timestamp,
  createdBy: actor,
  events: z.array(recordEvent).optional(),
  requests: z.record(z.string(), savedReceipt).optional(),
});
export type LegacyBoard = z.output<typeof legacyBoard>;
const criterion = z.strictObject({
  title: singleLine(1024),
  summary: text(4096).optional(),
  description: markdownLines(64 * 1024),
  id: z.string().regex(/^[A-Za-z0-9]{8}$/),
  completed: z.boolean(),
  completedAt: timestamp.nullable(),
  completedBy: actor.nullable(),
});
const taskShape = {
  id: taskId,
  key: taskReference,
  boardId: z.string(),
  title: singleLine(1024, true),
  description: markdownLines(256 * 1024),
  productLinks: z
    .array(
      z.strictObject({
        kind: z.enum(["feature", "scenario", "implementation"]),
        id: z.string().min(1).max(128),
      }),
    )
    .max(100)
    .optional(),
  column: z.enum(["inbox", "ready", "in-progress", "review", "done", "cancelled"]),
  rank: z.number().finite(),
  revision: positive,
  dependencies: z.array(taskId).max(200),
  related: z.array(taskId).max(200),
  parentId: taskId.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  createdBy: actor,
  updatedBy: actor,
  keys: z.array(taskReference).min(1),
  events: z.array(recordEvent).optional(),
  requests: z.record(
    z.string(),
    z.strictObject({ hash: z.string(), result: z.record(z.string(), z.json()) }),
  ),
  /** Классификация промежуточной локальной итерации; прежний reader её отбрасывал. */
  kind: z.string().optional(),
};
/** Задача версий 1–3 (критерии необязательны) и 4–5 (с критериями приёмки). */
export const legacyTask = z.union([
  z.strictObject({
    version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    ...taskShape,
    /**
     * Версии 1–3 критериев не писали, но прежний reader принимал файл и с полем (например,
     * после пересохранения старой версии): переход сохраняет такие критерии, а не отбрасывает.
     */
    acceptanceCriteria: z.array(criterion).max(100).optional(),
  }),
  z.strictObject({
    version: z.union([z.literal(4), z.literal(5)]),
    ...taskShape,
    acceptanceCriteria: z.array(criterion).max(100),
  }),
]);
export type LegacyTask = z.output<typeof legacyTask>;

/* Настройки проекта во встроенной конфигурации (project-settings.ts). */
export const legacyProjectSettings = z.strictObject({
  name: z
    .string()
    .max(120)
    .regex(/^[^\p{Cc}]+$/u)
    .refine((value) => value.trim().length > 0),
  slug: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  documentSections: z
    .array(z.strictObject({ id: documentSectionId, name: singleLine(80) }))
    .max(100)
    .refine((sections) => new Set(sections.map((section) => section.id)).size === sections.length)
    .optional(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  entityKey: legacyEntityKey.optional(),
  aliases: z.array(legacyEntityKey).optional(),
  events: z.array(recordEvent).optional(),
  requests: z.record(z.string(), savedReceipt).optional(),
});
export type LegacyProjectSettings = z.output<typeof legacyProjectSettings>;

/* Лента задачи (task-activity.ts, legacy/task-activity.ts, task-comments.ts). */
const activitySummary = {
  id: z.string().regex(/^[1-9]\d{0,14}$/),
  taskId: z.string(),
  sequence: positive,
  at: timestamp,
  actor,
  actorRole: z.enum(["operator", "orchestrator", "worker"]).optional(),
  action: z.string(),
  title: z.string(),
  operationId: z.string(),
  revision: positive,
  legacy: z.boolean(),
  fields: z.array(z.string()),
};
export const legacyActivitySummary = z.strictObject(activitySummary);
export const legacyActivityEvent = z.strictObject({
  ...activitySummary,
  changes: z.array(
    z.strictObject({
      field: z.string(),
      label: z.string(),
      format: z.enum(["text", "markdown"]),
      before: z.union([z.string(), z.array(z.string()), z.null()]),
      after: z.union([z.string(), z.array(z.string()), z.null()]),
      contentOmitted: z.literal(true).optional(),
    }),
  ),
  description: lines.optional(),
});
export const legacyActivityMeta = z.strictObject({
  version: z.literal(1),
  sequence: z.number().int().nonnegative(),
});
export const legacyActivityReceipt = z.strictObject({
  hash: z.string(),
  result: z.strictObject({
    id: z.string(),
    commentId: z.string().regex(/^[1-9]\d{0,14}$/),
    action: z.literal("comment-publish"),
    revision: positive,
    requestId,
  }),
});
export const legacyActivitySignal = z.strictObject({ operationId: z.string(), at: timestamp });

/* Граф (graph.ts, graph-format.ts, legacy/graph-event.ts, document-links.ts). */
export const legacyStoredEdge = z.strictObject({
  id: token,
  type: token,
  from: entityRef,
  to: entityRef,
  description: markdownLines(64 * 1024),
  revision: positive,
  source: z.literal("graph"),
  createdBy: actor,
  createdAt: timestamp,
});
export type LegacyStoredEdge = z.output<typeof legacyStoredEdge>;
const graphEvent = z.strictObject({
  action: z.enum(["add", "update", "remove"]),
  edge: legacyStoredEdge,
  actor,
  at: timestamp,
  revision: positive,
});
const graphReceipt = z.strictObject({
  hash: z.string(),
  result: z.strictObject({
    ids: z.array(z.string()),
    revision: positive,
    version: z.string(),
    requestId: z.string(),
  }),
});
export const legacyGraphMeta = z.strictObject({
  schemaVersion: z.literal(2),
  revision: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  indexFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export const legacyGraphCurrent = z.strictObject({
  schemaVersion: z.literal(2),
  active: z.boolean(),
  historyCount: z.number().int().nonnegative(),
  edge: legacyStoredEdge,
});
export type LegacyGraphCurrent = z.output<typeof legacyGraphCurrent>;
export const legacyGraphStoredEvent = z.strictObject({
  schemaVersion: z.literal(2),
  sequence: positive,
  event: graphEvent,
});
export const legacyGraphReceipt = graphReceipt;
/** Единый граф v1 `relations.json` (readLegacyGraph); ни один коммит его не писал. */
export const legacyGraphV1 = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  edges: z.array(legacyStoredEdge),
  events: z.array(graphEvent),
  requests: z.record(z.string(), graphReceipt),
});
export type LegacyGraphV1 = z.output<typeof legacyGraphV1>;
export const legacyDocumentBindings = z.strictObject({
  version: z.literal(1),
  bindings: z.record(
    z.string(),
    z.strictObject({ id: z.string(), from: entityRef, to: entityRef, type: z.string() }),
  ),
});

/* Удаления (entity-deletion.ts, entities.ts). */
export const legacyDeletionKeys = z.array(z.string());
export const legacyDeletionReceipt = z.strictObject({
  hash: z.string(),
  result: z.strictObject({
    action: z.literal("delete"),
    ref: entityRef,
    requestId,
    deleted: positive,
    detached: z.number().int().nonnegative(),
    relations: z.number().int().nonnegative(),
  }),
});
