import { z } from "zod";
import { workPlanDataSchema } from "./planning.js";
import { releaseDataSchema } from "./releases.js";
import {
  actorSchema,
  entityKeySchema,
  entityReferenceSchema,
  requestIdSchema,
  timestampSchema,
  singleLine,
  text,
} from "./primitives.js";
import {
  productFieldsSchema,
  productContractInputSchema,
  productStatusSchema,
} from "./entities/product.js";
import { productImplementationSchema } from "./entities/product-implementation.js";
import {
  boardTaskSchema,
  kanbanColumnSchema,
  createBoardTaskSchema,
} from "./entities/board-task.js";
import { boardSchema } from "./entities/board.js";
import { projectDisplayNameSchema, projectSettingsSchema } from "./entities/project-settings.js";
import {
  documentFormatSchema,
  documentKindSchema,
  documentStatusSchema,
  documentSectionsSchema,
  documentTagSchema,
  documentUrlSchema,
} from "./entities/document-library.js";
export {
  documentFormatSchema,
  documentKindSchema,
  documentStatusSchema,
  documentSectionsSchema,
  documentTagSchema,
  documentTagsSchema,
  documentUrlSchema,
  documentRelationSchema,
  documentRelationsSchema,
  defaultDocumentSections,
} from "./entities/document-library.js";

/** Основные виды; расширение происходит регистрацией определения и предметного обработчика. */
export const entityKinds = [
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
] as const;
export const entityKindSchema = z.enum(entityKinds).describe("Вид основной сущности");
export type EntityKind = z.infer<typeof entityKindSchema>;
export const entityRefSchema = z.strictObject({
  kind: entityKindSchema,
  id: z
    .string()
    .min(1)
    .max(128)
    .describe("Постоянный ID; внутренние отношения сохраняют только этот адрес"),
});
export type EntityRef = z.infer<typeof entityRefSchema>;

const [passport, feature, scenario, application, , document] = productFieldsSchema.options;
export const entityDataSchemas = {
  "work-plan": workPlanDataSchema,
  release: releaseDataSchema,
  project: projectSettingsSchema
    .omit({ revision: true })
    .extend({ kind: z.literal("project").describe("Настройки выбранного проекта") }),
  product: passport.extend({
    kind: z.literal("product").describe("Паспорт продукта"),
    name: singleLine(1024, true).describe("Название продукта; пусто до заполнения паспорта"),
    description: text(256 * 1024).describe(
      "Описание продукта в Markdown; пусто до заполнения паспорта",
    ),
  }),
  feature,
  scenario,
  application,
  implementation: productImplementationSchema.shape.fields,
  board: boardSchema.pick({ slug: true, prefix: true, applicationId: true }).extend({
    kind: z.literal("board").describe("Доска задач"),
    scope: boardSchema.shape.kind.describe("Область доски: продукт, приложение или инфраструктура"),
  }),
  task: boardTaskSchema
    .omit({
      id: true,
      key: true,
      revision: true,
      createdAt: true,
      updatedAt: true,
      createdBy: true,
      updatedBy: true,
    })
    .extend({ kind: z.literal("task").describe("Задача доски") }),
  document,
};
export const entityDataSchema = z.discriminatedUnion("kind", [
  workPlanDataSchema,
  releaseDataSchema,
  entityDataSchemas.project,
  entityDataSchemas.product,
  feature,
  scenario,
  application,
  entityDataSchemas.implementation,
  entityDataSchemas.board,
  entityDataSchemas.task,
  document,
]);
export type EntityData = z.infer<typeof entityDataSchema>;
export const entitySummarySchema = z.strictObject({
  ref: entityRefSchema.describe("Постоянный адрес в выбранном проекте"),
  key: z.string().describe("Текущий читаемый ключ для человека и агента"),
  title: z.string().describe("Однострочное название"),
  summary: z.string().describe("Краткое обычное описание без полного Markdown"),
  revision: z.number().int().nonnegative().describe("Ревизия записи для следующего изменения"),
  status: z.string().nullable().describe("Текущее предметное состояние; null, когда неприменимо"),
  active: z.boolean().describe("Активная запись; снятая реализация сохраняет адрес"),
  context: z
    .string()
    .optional()
    .describe("Приложение, доска или родитель для различения одинаковых названий"),
  document: z
    .strictObject({
      kind: documentKindSchema,
      status: documentStatusSchema,
      sectionId: z
        .string()
        .nullable()
        .describe("Эффективный раздел; удалённый раздел отображается как null"),
      pinned: z.boolean().describe("Закрепление в проекте"),
      format: documentFormatSchema
        .default("markdown")
        .describe(
          "Эффективный формат материала; прежние записи и карточки без поля читаются как markdown",
        ),
      url: documentUrlSchema.optional().describe("Внешний адрес материала формата link"),
      tags: z
        .array(z.string())
        .default([])
        .describe(
          "Нормализованные теги материала; пустой список допустим, прежние карточки без поля читаются как []",
        ),
      updatedAt: timestampSchema,
      linkCount: z
        .number()
        .int()
        .nonnegative()
        .describe(
          "Количество прямых прикреплений документа: relations и совместимые links вместе; 0 — без прикреплений",
        ),
      excerpt: z.string().optional().describe("Фрагмент совпадения полнотекстового поиска"),
    })
    .optional()
    .describe("Компактные свойства документа без полного Markdown"),
});
export const entityDetailSchema = entitySummarySchema.extend({
  data: entityDataSchema.describe("Полные типизированные данные; Markdown передаётся строками"),
  references: z
    .array(entitySummarySchema)
    .describe("Краткие карточки прямых предметных ссылок для отображения актуальных ключей"),
});
export type EntitySummary = z.infer<typeof entitySummarySchema>;
export type EntityDetail = z.infer<typeof entityDetailSchema>;

/** Виды с самостоятельным сценарием удаления. */
export const deletableEntityKindSchema = z
  .enum(["feature", "scenario", "application", "implementation", "task", "document"])
  .describe("Вид удаляемой сущности; проект, паспорт и системные доски не удаляются");
export const entityDeletionQuerySchema = z.strictObject({
  ref: entityReferenceSchema.describe("Ключ или постоянный адрес удаляемой сущности"),
  kind: deletableEntityKindSchema,
});
export const entityDeletionPreviewSchema = z.strictObject({
  target: entitySummarySchema.describe("Выбранная сущность"),
  version: z.string().describe("Версия состава удаления и связей для подтверждения"),
  deleted: z
    .array(entitySummarySchema)
    .max(1000)
    .describe("Полный состав удаления, не более 1000 сущностей"),
  detached: z
    .array(entitySummarySchema)
    .max(1000)
    .describe("Сохраняемые сущности, у которых снимаются ссылки"),
  relations: z.number().int().nonnegative().describe("Количество отзываемых активных связей графа"),
});
export const deleteEntitySchema = entityDeletionQuerySchema.extend({
  ifVersion: z.string().min(1).describe("Версия просмотренного состава удаления"),
  requestId: requestIdSchema,
  actor: actorSchema.optional().describe("Автор удаления; по умолчанию автор сервера"),
});
export const entityDeletedSchema = z.strictObject({
  action: z.literal("delete").describe("Каскадное удаление завершено"),
  ref: entityRefSchema,
  requestId: requestIdSchema,
  deleted: z.number().int().positive().describe("Количество удалённых сущностей"),
  detached: z
    .number()
    .int()
    .nonnegative()
    .describe("Количество сохранённых сущностей со снятыми ссылками"),
  relations: z.number().int().nonnegative().describe("Количество отозванных связей графа"),
});
export type EntityDeletionQuery = z.infer<typeof entityDeletionQuerySchema>;
export type EntityDeletionPreview = z.infer<typeof entityDeletionPreviewSchema>;
export type DeleteEntity = z.infer<typeof deleteEntitySchema>;
export type EntityDeleted = z.infer<typeof entityDeletedSchema>;

export const entityPageQuerySchema = z.strictObject({
  offset: z.coerce.number().int().nonnegative().default(0).describe("Смещение страницы"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(40)
    .describe("Размер страницы от 1 до 100"),
  version: z
    .string()
    .max(128)
    .optional()
    .describe("Версия первой страницы; изменение требует начать чтение заново"),
});
export type EntityPageQuery = z.input<typeof entityPageQuerySchema>;
const pageShape = {
  total: z.number().int().nonnegative().describe("Полное число результатов выбранной области"),
  nextOffset: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe("Смещение продолжения; null в конце"),
  version: z.string().describe("Версия согласованного снимка"),
};
export const entitiesQuerySchema = entityPageQuerySchema.extend({
  kind: entityKindSchema.optional(),
  q: z
    .string()
    .max(4096)
    .optional()
    .describe(
      "Поиск по ключам, ID, названию и краткому описанию; у документов также по Markdown-содержанию, url и тегам",
    ),
  refs: z
    .array(entityReferenceSchema)
    .max(100)
    .optional()
    .describe("Адресное чтение до 100 кратких карточек по ключам или ID"),
  board: entityReferenceSchema.optional().describe("Доска задач: ключ или ID"),
  application: entityReferenceSchema
    .optional()
    .describe("Приложение доски, реализации или задачи: ключ или ID"),
  feature: entityReferenceSchema.optional().describe("Фича сценария или реализации: ключ или ID"),
  scenario: entityReferenceSchema.optional().describe("Сценарий реализации: ключ или ID"),
  target: entityReferenceSchema
    .optional()
    .describe("Явная цель задачи, реализации или документа: ключ или ID"),
  parent: entityReferenceSchema.optional().describe("Родитель задачи: ключ или ID"),
  status: z.string().max(128).optional().describe("Предметное состояние выбранного вида"),
  active: z
    .enum(["true", "false"])
    .optional()
    .describe("Активность реализации; прежние ссылки доступны без фильтра"),
  section: z.string().max(64).optional().describe("Раздел документов; none — без раздела"),
  documentKind: documentKindSchema.optional(),
  documentFormat: documentFormatSchema
    .optional()
    .describe("Формат документа; прежние записи без поля относятся к markdown"),
  tags: z
    .array(documentTagSchema)
    .max(20)
    .optional()
    .describe(
      "Теги документа: выбираются материалы со всеми указанными тегами без учёта регистра; пустые значения игнорируются",
    ),
  unattached: z
    .enum(["true", "false"])
    .optional()
    .describe(
      "true — документы без прикреплений (нет relations и совместимых links); false — только прикреплённые",
    ),
  pinned: z
    .enum(["true", "false"])
    .optional()
    .describe("Только закреплённые либо незакреплённые документы"),
  archived: z
    .enum(["true", "false"])
    .optional()
    .describe("Включить только архив либо исключить архивные документы"),
  sort: z
    .enum(["key", "title", "updated"])
    .default("key")
    .describe(
      "Сортировка по ключу, названию или последнему обновлению (сначала новые, без ограничения давности)",
    ),
});
export type EntitiesQuery = z.input<typeof entitiesQuerySchema>;
export const entitiesPageSchema = z.strictObject({
  items: z.array(entitySummarySchema).describe("Страница кратких карточек"),
  libraryCounts: z
    .record(z.string(), z.number().int().nonnegative())
    .optional()
    .describe(
      "Счётчики библиотеки без поисковых фильтров: all, draft, pinned, archived, none и section:ID",
    ),
  ...pageShape,
});
export type EntitiesPage = z.infer<typeof entitiesPageSchema>;
export const entityGetQuerySchema = z.strictObject({
  ref: entityReferenceSchema,
  kind: entityKindSchema.optional().describe("Уточнение ожидаемого вида при разрешении адреса"),
});
export type EntityGetQuery = z.infer<typeof entityGetQuerySchema>;
export const entityKeysQuerySchema = entityPageQuerySchema.extend(entityGetQuerySchema.shape);
export const entityKeysPageSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        ref: entityRefSchema,
        key: z.string().describe("Разрешимый ключ записи"),
        current: z.boolean().describe("Основной ключ для текущего отображения"),
      }),
    )
    .describe("Текущий ключ и прежние алиасы"),
  ...pageShape,
});
export const entityKeySpacesQuerySchema = entityPageQuerySchema.extend({ kind: entityKindSchema });
export const entityKeySpacesSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        scope: entityRefSchema
          .nullable()
          .describe("Владелец нумерации; null для общего пространства вида"),
        title: z.string().describe("Назначение пространства ключей"),
        prefix: z.string().describe("Префикс назначаемых ключей"),
        pattern: z.string().describe("Человекочитаемый формат ключа"),
      }),
    )
    .describe("Актуальные пространства ключей выбранного вида"),
  ...pageShape,
});

const referenceList = z.array(entityReferenceSchema).max(100);
const taskCreate = z.strictObject({
  acceptanceCriteria: createBoardTaskSchema.shape.acceptanceCriteria,
  kind: z.literal("task").describe("Создать задачу"),
  board: entityReferenceSchema.describe("Ключ или ID доски"),
  title: boardTaskSchema.shape.title.default(""),
  description: boardTaskSchema.shape.description.default(""),
  targets: referenceList
    .default([])
    .describe("Ключи или ID фич, сценариев и реализаций, над которыми работает задача"),
  dependencies: referenceList
    .default([])
    .describe("Ключи или ID задач, необходимых для завершения"),
  related: referenceList.default([]).describe("Ключи или ID связанных задач без блокировки"),
  parent: entityReferenceSchema
    .nullable()
    .default(null)
    .describe("Ключ или ID родительской задачи"),
  column: kanbanColumnSchema.default("inbox"),
});
const implementationCreate = z.strictObject({
  kind: z.literal("implementation").describe("Создать участие приложения в фиче или сценарии"),
  application: entityReferenceSchema.describe("Ключ или ID приложения"),
  target: entityReferenceSchema.describe("Ключ или ID фичи либо сценария"),
  title: productContractInputSchema.shape.title.describe("Однострочное название вклада"),
  description: productContractInputSchema.shape.description.describe("Описание вклада в Markdown"),
  status: productStatusSchema
    .default("none")
    .describe("Состояние вклада; done подтверждает актуальные требования"),
});
const documentCreate = document.omit({ links: true }).extend({
  body: document.shape.body.default(""),
  targets: referenceList.default([]).describe("Ключи или ID продуктовых областей документа"),
});
export const entityCreateDataSchemas = {
  product: passport.extend({ kind: z.literal("product").describe("Создать паспорт продукта") }),
  feature,
  scenario: scenario.extend({
    featureId: entityReferenceSchema.describe("Ключ или ID родительской фичи"),
  }),
  application,
  implementation: implementationCreate,
  task: taskCreate,
  document: documentCreate,
};
const writeMetadata = {
  requestId: requestIdSchema,
  actor: actorSchema.optional().describe("Автор; по умолчанию автор текущего интерфейса"),
};
export const entityCreateSchema = z.strictObject({
  data: z
    .discriminatedUnion("kind", [
      entityCreateDataSchemas.product,
      feature,
      entityCreateDataSchemas.scenario,
      application,
      implementationCreate,
      taskCreate,
      documentCreate,
    ])
    .describe("Типизированные данные создаваемой сущности"),
  ...writeMetadata,
});
export type CreateEntity = z.input<typeof entityCreateSchema>;

export const entityUpdateDataSchemas = {
  project: z.strictObject({
    kind: z.literal("project").describe("Изменить имя проекта"),
    name: projectDisplayNameSchema.optional(),
    documentSections: documentSectionsSchema.optional(),
  }),
  product: entityCreateDataSchemas.product.partial().required({ kind: true }),
  feature: feature.partial().required({ kind: true }),
  scenario: scenario.omit({ featureId: true }).partial().required({ kind: true }),
  application: application.omit({ slug: true, prefix: true }).partial().required({ kind: true }),
  implementation: implementationCreate
    .omit({ application: true, target: true })
    .extend({ status: productStatusSchema })
    .partial()
    .required({ kind: true }),
  task: z.strictObject({
    kind: z.literal("task").describe("Изменить содержание задачи"),
    title: boardTaskSchema.shape.title.optional(),
    description: boardTaskSchema.shape.description.optional(),
    targets: referenceList
      .optional()
      .describe("Новый набор продуктовых целей; отсутствие сохраняет текущий набор"),
  }),
  document: documentCreate
    .extend({
      body: document.shape.body,
      targets: referenceList.describe("Новый набор областей документа"),
    })
    .partial()
    .required({ kind: true }),
};
const writeReference = {
  ref: entityReferenceSchema,
  ifRevision: z.number().int().nonnegative().describe("Прочитанная ревизия изменяемой записи"),
  ...writeMetadata,
};
export const entityUpdateSchema = z.strictObject({
  ...writeReference,
  changes: z
    .discriminatedUnion("kind", [
      entityUpdateDataSchemas.project,
      entityUpdateDataSchemas.product,
      entityUpdateDataSchemas.feature,
      entityUpdateDataSchemas.scenario,
      entityUpdateDataSchemas.application,
      entityUpdateDataSchemas.implementation,
      entityUpdateDataSchemas.task,
      entityUpdateDataSchemas.document,
    ])
    .describe("Только изменяемые поля выбранного вида"),
});
export type UpdateEntity = z.input<typeof entityUpdateSchema>;
export const entityRenameSchema = z.strictObject({ ...writeReference, key: entityKeySchema });
export type RenameEntity = z.infer<typeof entityRenameSchema>;
export const entityMoveTaskSchema = z.strictObject({
  ...writeReference,
  board: entityReferenceSchema
    .optional()
    .describe("Ключ или ID новой доски; без него текущая доска"),
  column: kanbanColumnSchema,
  before: entityReferenceSchema
    .nullable()
    .default(null)
    .describe("Ключ или ID следующей задачи; null — конец колонки"),
});
export type MoveEntityTask = z.input<typeof entityMoveTaskSchema>;
export const entityLinkTaskSchema = z.strictObject({
  ...writeReference,
  target: entityReferenceSchema.describe("Ключ или ID второй задачи"),
  relation: z
    .enum(["depends-on", "related", "parent"])
    .describe("Зависит от, связана с или родитель текущей задачи"),
  remove: z.boolean().default(false).describe("Удалить выбранное отношение"),
});
export type LinkEntityTask = z.input<typeof entityLinkTaskSchema>;
export const entitySavedSchema = z.strictObject({
  ref: entityRefSchema,
  key: z.string().describe("Ключ записи на момент подтверждённой операции"),
  revision: z.number().int().nonnegative().describe("Ревизия после операции"),
  requestId: requestIdSchema,
  action: z.enum(["create", "update", "rename", "move", "link"]).describe("Выполненное действие"),
});
export type EntitySaved = z.infer<typeof entitySavedSchema>;

export const entityTypeSchema = z.strictObject({
  kind: entityKindSchema,
  title: z.string().describe("Название вида по-русски"),
  description: z.string().describe("Для чего нужна эта сущность"),
  contractVersion: z.number().int().positive().describe("Версия переносимого определения"),
  keyPolicy: z
    .string()
    .describe("Правила назначения ключа; фактические префиксы доступны в key-spaces"),
  filters: z.array(z.string()).describe("Поддерживаемые фильтры записей этого вида"),
  actions: z
    .array(z.string())
    .describe("Поддерживаемые действия; предметные условия проверяются Core"),
});
export type EntityType = z.infer<typeof entityTypeSchema>;
export const entityTypesSchema = z.strictObject({ items: z.array(entityTypeSchema), ...pageShape });
export const entityTypeDetailSchema = entityTypeSchema.extend({
  schema: z.record(z.string(), z.unknown()).describe("JSON Schema полных данных сущности"),
  createSchema: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe("JSON Schema создания; null, если создание выполняет другой сценарий"),
  updateSchema: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe("JSON Schema изменения; null для вычисляемого содержания"),
});
export const entityTypeQuerySchema = z.strictObject({ kind: entityKindSchema });

/** Назначение вида и его возможности принадлежат тому же контракту, что поля. */
export const entityDefinitions: readonly EntityType[] = [
  {
    kind: "work-plan",
    title: "План работ",
    description:
      "Цель, этапы и состав существующих задач; переходы выполняются предметными операциями планирования",
    keyPolicy: "PLN-<номер>; постоянный ID, прежние ключи резервируются",
    filters: ["status"],
    actions: ["planning"],
  },
  {
    kind: "release",
    title: "Релиз",
    description: "Самостоятельный выпуск со ссылками на реализованные планы",
    keyPolicy: "REL-<номер>; обозначение версии не является идентичностью",
    filters: ["status"],
    actions: ["releases"],
  },
  {
    kind: "project",
    title: "Проект",
    description: "Изолированная область данных и настроек Relay",
    keyPolicy: "PROJECT; имя и адрес проекта независимы от его ID",
    filters: [],
    actions: ["update", "rename"],
  },
  {
    kind: "product",
    title: "Продукт",
    description: "Паспорт создаваемого продукта: назначение, пользователи и границы",
    keyPolicy: "PRODUCT; один паспорт в проекте",
    filters: [],
    actions: ["create", "update", "rename"],
  },
  {
    kind: "feature",
    title: "Фича",
    description: "Устойчивая возможность продукта, объединяющая сценарии",
    keyPolicy: "FEATURE-<номер>; прежние ключи резервируются",
    filters: ["status"],
    actions: ["create", "update", "rename"],
  },
  {
    kind: "scenario",
    title: "Сценарий",
    description: "Наблюдаемое действие и результат внутри фичи",
    keyPolicy: "SCENARIO-<номер>; постоянная принадлежность фиче",
    filters: ["feature", "status"],
    actions: ["create", "update", "rename"],
  },
  {
    kind: "application",
    title: "Приложение",
    description: "Программная часть продукта со своими реализациями и доской",
    keyPolicy: "Префикс приложения при создании; ключ затем может изменяться",
    filters: [],
    actions: ["create", "update", "rename"],
  },
  {
    kind: "implementation",
    title: "Реализация",
    description: "Вклад приложения в фичу или сценарий с собственным содержанием и состоянием",
    keyPolicy: "<префикс приложения>-FI/SI-<номер>",
    filters: ["application", "feature", "scenario", "target", "status", "active"],
    actions: ["create", "update", "rename"],
  },
  {
    kind: "board",
    title: "Доска",
    description: "Организация задач продукта, приложения или инфраструктуры",
    keyPolicy: "BOARD-<префикс>; доска создаётся при инициализации или вместе с приложением",
    filters: ["application"],
    actions: ["rename"],
  },
  {
    kind: "task",
    title: "Задача",
    description: "Конкретная работа с целями реализации, зависимостями и состоянием",
    keyPolicy: "<префикс доски>-<номер>; перенос назначает новый ключ и сохраняет алиасы",
    filters: ["board", "application", "target", "parent", "status"],
    actions: ["create", "update", "rename", "move", "link"],
  },
  {
    kind: "document",
    title: "Документ",
    description:
      "Материал библиотеки знаний: Markdown-текст или внешняя ссылка с типом, тегами, разделом и прикреплениями",
    keyPolicy: "DOC-<номер>; ключ не определяет область применимости",
    filters: [
      "target",
      "status",
      "section",
      "documentKind",
      "documentFormat",
      "tags",
      "unattached",
      "pinned",
      "archived",
    ],
    actions: ["create", "update", "rename", "relate", "bulk", "facets"],
  },
].map((definition) => ({ ...definition, kind: definition.kind as EntityKind, contractVersion: 1 }));
