import { z } from "zod";
import {
  actorSchema,
  singleLine,
  text,
  timestampSchema,
  requestIdSchema,
  entityKeySchema,
  entityReferenceSchema,
} from "../primitives.js";
import { applicationSlugSchema, boardPrefixSchema } from "./board.js";
import { documentKindSchema, documentMetadataShape } from "./document-library.js";
import { boardTaskReferenceSchema, kanbanColumnSchema } from "./board-task.js";
import { planStatusSchema, planningCountsSchema } from "../planning.js";
import { releaseReadinessSchema, releaseStatusSchema } from "../releases.js";

export const productIdSchema = z
  .string()
  .regex(
    /^(?:[A-Za-z0-9]{8}|passport|(?:feature|scenario|application|scope|document|contract)_[a-f0-9]{32})$/,
  );
export const productKeySchema = entityKeySchema;
export const productRefSchema = entityReferenceSchema.describe(
  "Постоянный ID или читаемый ключ сущности в выбранном проекте",
);
const title = singleLine(1024);
const markdown = text(256 * 1024).refine(
  (value) => value.trim().length > 0,
  "Markdown не должен быть пустым",
);
const description = {
  name: title.describe("Однострочное название"),
  summary: text(4096).describe("Краткое многострочное описание обычным текстом"),
  description: markdown.describe("Полное описание в Markdown"),
};
export const productStatusSchema = z.enum(["none", "partial", "done"]);
export const productReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("product") }),
  z.strictObject({ kind: z.literal("feature"), id: productIdSchema }),
  z.strictObject({ kind: z.literal("scenario"), id: productIdSchema }),
  z.strictObject({ kind: z.literal("application"), id: productIdSchema }),
  z.strictObject({
    kind: z.literal("implementation"),
    applicationId: productIdSchema,
    id: productIdSchema,
  }),
]);
export const productContractInputSchema = z.strictObject({
  featureId: productIdSchema.describe("Постоянный ID общей фичи"),
  scenarioId: productIdSchema
    .nullable()
    .describe("Постоянный ID сценария; null для общего вклада в фичу"),
  title: title.describe("Однострочное название реализации"),
  description: markdown.describe("Описание вклада приложения в Markdown"),
  status: productStatusSchema.describe("Состояние вклада приложения"),
});
export const productContractSchema = productContractInputSchema.extend({
  id: productIdSchema,
  key: productKeySchema.optional(),
  revision: z.number().int().positive().optional(),
  active: z.boolean(),
  basis: z.string(),
});
export const productFieldsSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("passport"), ...description }),
  z.strictObject({ kind: z.literal("feature"), ...description }),
  z.strictObject({
    kind: z.literal("scenario"),
    featureId: productIdSchema.describe("Постоянный ID родительской фичи"),
    name: title.describe("Однострочное название сценария"),
    description: markdown.describe("Описание поведения сценария в Markdown"),
  }),
  z.strictObject({
    kind: z.literal("application"),
    ...description,
    slug: applicationSlugSchema,
    prefix: boardPrefixSchema
      .optional()
      .describe("Префикс задач доски; при создании по умолчанию из slug, затем неизменяем"),
    type: z
      .enum(["frontend", "backend", "internal"])
      .describe("Назначение приложения: клиентское, серверное или внутреннее"),
  }),
  z.strictObject({
    kind: z.literal("scope"),
    applicationId: productIdSchema,
    contracts: z.array(productContractSchema).max(10000),
  }),
  z.strictObject({
    kind: z.literal("document"),
    name: title.describe("Однострочное название документа"),
    summary: text(4096).describe("Краткое обычное описание документа"),
    body: markdown.describe("Полный текст документа в Markdown"),
    documentKind: documentKindSchema,
    ...documentMetadataShape,
    links: z
      .array(productReferenceSchema)
      .max(1000)
      .describe("Явные области применимости документа по постоянным ID"),
  }),
]);
const writableFields = z.discriminatedUnion("kind", [
  productFieldsSchema.options[0],
  productFieldsSchema.options[1],
  productFieldsSchema.options[2].extend({ featureId: productRefSchema }),
  productFieldsSchema.options[3],
  productFieldsSchema.options[5].extend({
    links: z
      .array(
        z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("product") }),
          z.strictObject({ kind: z.literal("feature"), id: productRefSchema }),
          z.strictObject({ kind: z.literal("scenario"), id: productRefSchema }),
          z.strictObject({ kind: z.literal("application"), id: productRefSchema }),
          z.strictObject({
            kind: z.literal("implementation"),
            applicationId: productRefSchema,
            id: productRefSchema,
          }),
        ]),
      )
      .max(1000),
  }),
  z.strictObject({
    kind: z.literal("scope"),
    applicationId: productRefSchema,
    contracts: z
      .array(
        productContractInputSchema.extend({
          featureId: productRefSchema,
          scenarioId: productRefSchema.nullable(),
          key: productKeySchema
            .optional()
            .describe("Прочитанный ключ; не меняется операцией замены состава"),
          revision: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Прочитанная ревизия реализации; замена состава проверяет общую версию"),
        }),
      )
      .max(10000),
  }),
  z.strictObject({
    kind: z.literal("contract"),
    applicationId: productRefSchema,
    contractId: productRefSchema,
    status: productStatusSchema,
    title: title.optional(),
    description: markdown.optional(),
  }),
  productContractInputSchema.extend({
    kind: z
      .literal("implementation")
      .describe("Добавить одну реализацию, сохраняя остальные вклады"),
    applicationId: productRefSchema.describe("Ключ или ID приложения"),
    featureId: productRefSchema.describe("Ключ или ID общей фичи"),
    scenarioId: productRefSchema
      .nullable()
      .describe("Ключ или ID сценария; null для общего вклада"),
  }),
]);
export const productMutationSchema = z.strictObject({
  action: z.enum(["create", "update"]),
  id: productRefSchema.optional(),
  key: productKeySchema
    .optional()
    .describe("Новый ключ при явном разрешении конфликта; ID и связи сохраняются"),
  fields: writableFields,
  ifRevision: z.number().int().nonnegative().optional(),
  ifVersion: z.string().optional(),
  requestId: requestIdSchema,
  actor: actorSchema.optional(),
});
export const productSavedSchema = z.strictObject({
  id: productIdSchema,
  key: productKeySchema.optional(),
  revision: z.number().int().positive(),
});
export const productRecordSchema = z.strictObject({
  version: z.literal(1),
  productId: z.string().min(1),
  id: productIdSchema,
  key: productKeySchema.optional(),
  reservedKeys: z.array(productKeySchema).optional(),
  revision: z.number().int().positive(),
  fields: productFieldsSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  createdBy: actorSchema,
  updatedBy: actorSchema,
});
export const productReadinessSchema = z.strictObject({
  id: productIdSchema,
  status: productStatusSchema,
  participants: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
});
export const productStateSchema = z.strictObject({
  productId: z.string(),
  version: z.string(),
  records: z.array(productRecordSchema),
  readiness: z.array(productReadinessSchema),
});
export const productContextQuerySchema = z.strictObject({
  id: productRefSchema.optional(),
  applicationId: productRefSchema.optional(),
});
export const productContextSchema = z.strictObject({
  productId: z.string(),
  version: z.string(),
  records: z.array(
    z.strictObject({
      record: productRecordSchema,
      reasons: z.array(z.string()),
    }),
  ),
  readiness: z.array(productReadinessSchema),
});
export const productListQuerySchema = z.strictObject({
  kind: z.enum(["passport", "feature", "scenario", "application", "scope", "document"]).optional(),
  q: z.string().max(4096).optional(),
  id: productRefSchema.optional(),
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const productListSchema = z.strictObject({
  version: z.string(),
  total: z.number(),
  items: z.array(productRecordSchema),
  nextOffset: z.number().nullable(),
});
/** Ограничение каждой обзорной подборки; полные числа передаются отдельно. */
export const PRODUCT_OVERVIEW_PREVIEW_LIMIT = 5;
/** Предел детерминированного фрагмента Markdown в символах Unicode. */
export const PRODUCT_OVERVIEW_EXCERPT_LIMIT = 600;

const overviewCount = (description: string) => z.number().int().nonnegative().describe(description);

/** Ограниченная подборка: полный total и явный признак продолжения. */
const overviewPreview = <T extends z.ZodType>(
  item: T,
  subject: string,
  continuation = "полный список читайте каталогом",
) =>
  z
    .strictObject({
      total: overviewCount(
        `Полное число ${subject} в проекте независимо от ограничения подборки; 0 — таких нет`,
      ),
      shown: overviewCount("Число элементов в items, не более 5"),
      hasMore: z.boolean().describe(`true, если есть элементы сверх показанных; ${continuation}`),
      items: z
        .array(item)
        .max(PRODUCT_OVERVIEW_PREVIEW_LIMIT)
        .describe(`Первые ${subject} по порядку подборки; пустой массив — таких нет`),
    })
    .describe(`Краткая подборка: ${subject}`);

const overviewExcerptSchema = z
  .strictObject({
    text: z
      .string()
      .describe(
        "Начало исходного Markdown без изменения смысла: обрезанные края, не более 600 символов",
      ),
    truncated: z.boolean().describe("true, если исходный текст длиннее фрагмента"),
  })
  .describe("Детерминированный фрагмент сохранённого текста, не новое описание");

const featureStatusCountsSchema = z
  .strictObject({
    none: overviewCount("Нет выполненных обязательств или работ"),
    partial: overviewCount("Выполнена часть обязательств"),
    done: overviewCount("Все обязательства фактически выполнены задачами"),
  })
  .describe("Разбиение по фактической готовности Core; все ключи присутствуют, включая нули");

const implementationCountsSchema = (subject: string) =>
  z
    .strictObject({
      total: overviewCount(`Все ${subject}, включая снятые`),
      active: overviewCount(`Действующие ${subject}`),
      withdrawn: overviewCount(
        `Снятые ${subject}; сохраняются для истории и не влияют на готовность`,
      ),
      byStatus: featureStatusCountsSchema.describe(
        `Готовность только действующих ${subject} по задачам`,
      ),
    })
    .describe(`Реализации: ${subject}`);

const overviewBoardSchema = z
  .strictObject({
    id: z.string().describe("Постоянный ID доски"),
    prefix: boardPrefixSchema,
    slug: z.string().describe("Адрес доски в выбранном проекте"),
    kind: z
      .enum(["product", "application", "infrastructure"])
      .describe("Область ответственности доски"),
    name: z.string().describe("Название доски; для приложения — его актуальное название"),
    applicationId: productIdSchema
      .nullable()
      .describe("ID приложения доски; null у системных досок"),
    tasks: z
      .strictObject({
        total: overviewCount("Все задачи доски, включая done и cancelled"),
        open: overviewCount("Задачи доски вне колонок done и cancelled"),
      })
      .describe("Счётчики задач доски; пустая доска имеет нули"),
  })
  .describe("Доска проекта в обзоре");

const taskColumnCountsSchema = z
  .strictObject({
    inbox: overviewCount("Задачи в колонке inbox"),
    ready: overviewCount("Задачи в колонке ready"),
    "in-progress": overviewCount("Задачи в колонке in-progress"),
    review: overviewCount("Задачи в колонке review"),
    done: overviewCount("Задачи в колонке done, независимо от фактического выполнения"),
    cancelled: overviewCount("Отменённые задачи; отмена не является выполнением"),
  })
  .describe("Все шесть колонок, включая нулевые; сумма равна tasks.total");

const overviewTaskRefSchema = z
  .strictObject({
    id: z.string().describe("Постоянный ID задачи"),
    key: z.string().describe("Текущий ключ задачи с префиксом доски"),
    title: z.string().describe("Однострочный заголовок задачи; может быть пустым"),
    column: kanbanColumnSchema,
  })
  .describe("Краткий адрес задачи");

const overviewTaskSchema = overviewTaskRefSchema
  .extend({
    board: z
      .strictObject({
        id: z.string().describe("Постоянный ID доски"),
        prefix: boardPrefixSchema,
        slug: z.string().describe("Адрес доски"),
        name: z.string().describe("Название доски"),
      })
      .describe("Текущая доска задачи"),
    updatedAt: timestampSchema.describe("Время последнего изменения задачи"),
    completed: z
      .boolean()
      .describe("Фактически выполнена: done, все критерии и обязательства выполнены"),
    acceptance: z
      .strictObject({
        total: overviewCount("Все критерии приёмки задачи"),
        completed: overviewCount("Отмеченные выполненными критерии"),
      })
      .describe("Прогресс критериев приёмки"),
    blockers: z
      .strictObject({
        total: overviewCount("Все невыполненные прямые зависимости и подзадачи; 0 — блокеров нет"),
        items: z
          .array(
            overviewTaskRefSchema
              .extend({
                relation: z
                  .enum(["dependency", "subtask"])
                  .describe("Причина: невыполненная зависимость или подзадача"),
              })
              .describe("Невыполненное обязательство, блокирующее задачу"),
          )
          .max(PRODUCT_OVERVIEW_PREVIEW_LIMIT)
          .describe(
            "Первые причины блокировки, не более 5: сначала зависимости в сохранённом порядке, затем подзадачи",
          ),
      })
      .describe("Причины блокировки из действующей модели обязательств"),
  })
  .describe("Задача, требующая внимания");

const overviewDocumentSchema = z
  .strictObject({
    id: productIdSchema.describe("Постоянный ID документа"),
    key: productKeySchema.nullable().describe("Читаемый ключ документа либо null"),
    name: z.string().describe("Однострочное название документа"),
    summary: z.string().describe("Краткое обычное описание; может быть пустым"),
    documentKind: documentKindSchema,
    sectionId: z
      .string()
      .nullable()
      .describe("Раздел библиотеки; null — без раздела или раздел больше не настроен"),
    updatedAt: timestampSchema.describe("Время последнего изменения документа"),
  })
  .describe("Закреплённый действующий документ");

const overviewPlanSchema = z
  .strictObject({
    id: z.string().describe("Постоянный ID плана"),
    key: z.string().describe("Читаемый ключ плана"),
    title: z.string().describe("Название плана"),
    summary: z.string().describe("Краткое описание плана; может быть пустым"),
    goal: overviewExcerptSchema.describe(
      "Начало цели плана в Markdown; пустой text — цель не задана",
    ),
    status: planStatusSchema,
    updatedAt: timestampSchema.describe("Время последнего изменения плана"),
    stages: z
      .strictObject({
        total: overviewCount("Все этапы плана"),
        completed: overviewCount("Этапы с непустым и фактически выполненным составом"),
      })
      .describe("Прогресс этапов"),
    nextStage: z
      .strictObject({
        id: z.string().describe("Внутренний ID этапа"),
        title: z.string().describe("Название этапа"),
      })
      .nullable()
      .describe("Первый незавершённый этап; null — все этапы выполнены или их нет"),
    counts: planningCountsSchema.describe("Фактическое выполнение задач плана"),
    ready: z.boolean().describe("Весь непустой состав фактически выполнен"),
  })
  .describe("Активный план работ");

const overviewReleaseSchema = z
  .strictObject({
    id: z.string().describe("Постоянный ID релиза"),
    key: z.string().describe("Читаемый ключ релиза"),
    title: z.string().describe("Название релиза"),
    version: z.string().describe("Пользовательское обозначение выпуска; не ревизия записи"),
    status: releaseStatusSchema,
    plannedFor: z.iso
      .date()
      .nullable()
      .describe("Плановая дата YYYY-MM-DD либо null, если не задана"),
    releasedAt: timestampSchema.nullable().describe("Фактическое время выпуска либо null"),
    updatedAt: timestampSchema.describe("Время последнего изменения релиза"),
    readiness: releaseReadinessSchema.describe(
      "Фактическая готовность состава; не совпадает с собственным статусом релиза",
    ),
  })
  .describe("Релиз проекта; не относится к отдельному приложению");

/** Дополнительное пояснение продолжения у подборок метрик оператора. */
const metricContinuation = "полный список читайте детализацией метрики product overview";

const overviewTaskBoardSchema = z
  .strictObject({
    id: z.string().describe("Постоянный ID доски"),
    prefix: boardPrefixSchema,
    slug: z.string().describe("Адрес доски"),
    name: z.string().describe("Название доски"),
  })
  .describe("Текущая доска задачи");

export const overviewObligationReasonSchema = z
  .enum(["CRITERION_INCOMPLETE", "DEPENDENCY_INCOMPLETE", "CHILD_INCOMPLETE"])
  .describe(
    "Причина невыполненных обязательств: невыполненный критерий, прямая зависимость или подзадача",
  );

const overviewOperatorTaskSchema = overviewTaskSchema
  .extend({
    reasons: z
      .array(overviewObligationReasonSchema)
      .max(3)
      .describe(
        "Все причины, по которым обязательства задачи сейчас не выполнены, без повторов; пустой массив — обязательства выполнены",
      ),
  })
  .describe("Задача метрики оператора с основанием включения");

const overviewAffectedTaskSchema = overviewTaskRefSchema
  .extend({
    board: overviewTaskBoardSchema,
    updatedAt: timestampSchema.describe("Время последнего изменения задачи"),
    relations: z
      .array(z.enum(["dependency", "subtask"]))
      .min(1)
      .max(2)
      .describe(
        "Прямая связь с блокером: зависимость, подзадача или обе; задача учитывается один раз",
      ),
  })
  .describe("Незавершённая задача, которую блокер задерживает напрямую");

const overviewBlockerImpactSchema = overviewTaskRefSchema
  .extend({
    board: overviewTaskBoardSchema,
    updatedAt: timestampSchema.describe("Время последнего изменения блокера"),
    affected: z
      .strictObject({
        total: overviewCount(
          "Число различных незавершённых задач, у которых эта задача — прямой невыполненный блокер",
        ),
        items: z
          .array(overviewAffectedTaskSchema)
          .max(PRODUCT_OVERVIEW_PREVIEW_LIMIT)
          .describe(
            "Первые затронутые задачи: новые изменения первыми, затем ID; полный список — метрика blocker-affected",
          ),
      })
      .describe("Прямо затронутые незавершённые задачи; не транзитивное влияние"),
  })
  .describe(
    "Прямой блокер незавершённой работы; может находиться в любой колонке, включая cancelled",
  );

const overviewBoardWorkSchema = overviewBoardSchema
  .omit({ tasks: true })
  .extend({
    tasks: z
      .strictObject({
        total: overviewCount("Все задачи доски, включая done и cancelled"),
        byColumn: taskColumnCountsSchema,
        completed: overviewCount("Фактически выполненные задачи доски"),
        remaining: overviewCount(
          "Незавершённые: не cancelled и фактически не выполнены, включая done с открытыми обязательствами; не оценка трудозатрат",
        ),
        blockedRemaining: overviewCount(
          "Незавершённые задачи с прямыми блокерами; пересекается с колонками и remaining",
        ),
        readyToStart: overviewCount("Колонка ready без блокеров"),
      })
      .describe("Распределение задач доски; показатели пересекаются и не складываются"),
  })
  .describe("Доска с распределением незавершённой работы");

const overviewOperatorPlanSchema = z
  .strictObject({
    id: z.string().describe("Постоянный ID плана"),
    key: z.string().describe("Читаемый ключ плана"),
    title: z.string().describe("Название плана"),
    status: planStatusSchema,
    updatedAt: timestampSchema.describe("Время последнего изменения плана"),
    stages: z
      .strictObject({
        total: overviewCount("Все этапы плана"),
        completed: overviewCount("Этапы с непустым и фактически выполненным составом"),
      })
      .describe("Прогресс этапов"),
    counts: planningCountsSchema.describe("Фактическое выполнение задач плана"),
  })
  .describe("План с фактически выполненным непустым составом");

const overviewTaskColumnsWorkSchema = z
  .strictObject({
    "in-progress": overviewCount("Задачи в колонке in-progress"),
    review: overviewCount("Задачи в колонке review"),
  })
  .describe("Разбиение по колонкам исполняемой работы; сумма равна total");

export const productOverviewOperatorSchema = z
  .strictObject({
    review: z
      .strictObject({
        total: overviewCount("Все задачи в колонке review; равно сумме двух групп"),
        obligationsMet: overviewPreview(
          overviewOperatorTaskSchema,
          "задач review, чьи критерии и прямые обязательства выполнены, новые изменения первыми",
          metricContinuation,
        ).describe(
          "Обязательства выполнены: завершение можно рассмотреть; это не внешняя проверка результата",
        ),
        obligationsOpen: overviewPreview(
          overviewOperatorTaskSchema,
          "задач review с невыполненными критериями или прямыми обязательствами, новые изменения первыми",
          metricContinuation,
        ).describe("Остались обязательства: причины указаны в reasons и blockers"),
      })
      .describe("M-01. Очередь проверки, разделённая по готовности обязательств"),
    blockerImpact: overviewPreview(
      overviewBlockerImpactSchema,
      "прямых блокеров незавершённой работы: больше затронутых задач первыми, затем ID",
      metricContinuation,
    ).describe("M-02. Влияние прямых блокеров: не критический путь и не рекомендация приоритета"),
    unplannedWork: overviewPreview(
      overviewOperatorTaskSchema,
      "задач in-progress и review вне открытых планов, новые изменения первыми",
      metricContinuation,
    )
      .extend({ byColumn: overviewTaskColumnsWorkSchema })
      .describe(
        "M-03. Исполняемая работа вне явного состава планов draft и active; сигнал, а не ошибка",
      ),
    boardWork: z
      .strictObject({
        remaining: overviewCount("Все незавершённые задачи проекта; сумма remaining по доскам"),
        blockedRemaining: overviewCount("Незавершённые задачи проекта с прямыми блокерами"),
        boards: overviewPreview(
          overviewBoardWorkSchema,
          "досок: больше незавершённых задач первыми, затем ID; включая пустые",
          metricContinuation,
        ),
      })
      .describe("M-04. Распределение работы по доскам; не загрузка людей"),
    openPlansComplete: overviewPreview(
      overviewOperatorPlanSchema,
      "планов draft и active с выполненным непустым составом, новые изменения первыми",
      metricContinuation,
    ).describe(
      "M-05. Состав выполнен, план открыт; завершение плана дополнительно требует итог и ревизию",
    ),
    releasePreparation: z
      .strictObject({
        readyReleases: overviewPreview(
          overviewReleaseSchema,
          "запланированных релизов с готовым составом: ближайшая дата, без даты в конце, затем ID",
          metricContinuation,
        ).describe("Можно рассмотреть явную фиксацию выпуска; не подтверждение CI или публикации"),
        completedPlansOutsideReleases: overviewPreview(
          overviewOperatorPlanSchema,
          "завершённых готовых планов вне релизов planned и released, новые изменения первыми",
          metricContinuation,
        ).describe("Готовые планы, ещё не включённые в запланированный или выпущенный релиз"),
      })
      .describe("M-06. Подготовка выпуска; чтение не меняет статусы планов и релизов"),
  })
  .describe(
    "Показатели оператора: полные счётчики и подборки; показатели пересекаются и не складываются",
  );

const passportPresent = {
  id: productIdSchema.describe("Постоянный ID паспорта"),
  key: productKeySchema.nullable().describe("Читаемый ключ продукта либо null"),
  revision: z.number().int().positive().describe("Ревизия паспорта"),
  name: z.string().describe("Название продукта из паспорта"),
  updatedAt: timestampSchema.describe("Время последнего изменения паспорта"),
};

export const productOverviewSnapshotSchema = z
  .strictObject({
    project: z
      .strictObject({
        id: z
          .string()
          .nullable()
          .describe("Постоянный ID проекта; null только у прежней конфигурации без ID"),
        name: z.string().describe("Отображаемое имя проекта; не подменяется названием продукта"),
        slug: z.string().describe("Адрес проекта"),
      })
      .describe("Выбранный проект"),
    passport: z
      .discriminatedUnion("state", [
        z
          .strictObject({
            state: z.literal("missing").describe("Паспорт ещё не создан"),
          })
          .describe("Паспорт отсутствует; это не ошибка чтения"),
        z
          .strictObject({
            state: z.literal("filled").describe("Паспорт с краткой summary"),
            ...passportPresent,
            summary: z.string().min(1).describe("Сохранённая краткая summary паспорта"),
          })
          .describe("Заполненный паспорт"),
        z
          .strictObject({
            state: z.literal("no-summary").describe("Паспорт есть, summary пустая"),
            ...passportPresent,
            excerpt: overviewExcerptSchema.describe(
              "Фрагмент описания паспорта вместо пустой summary; сохранённый паспорт не меняется",
            ),
          })
          .describe("Паспорт без summary"),
      ])
      .describe("Состояние паспорта продукта"),
    knowledge: z
      .strictObject({
        features: z
          .strictObject({
            total: overviewCount("Все фичи продукта"),
            byStatus: featureStatusCountsSchema,
          })
          .describe("Общие фичи"),
        scenarios: z
          .strictObject({
            total: overviewCount("Все сценарии продукта"),
            byStatus: featureStatusCountsSchema,
          })
          .describe("Сценарии фич"),
        applications: z
          .strictObject({
            total: overviewCount("Все приложения проекта"),
            byType: z
              .strictObject({
                frontend: overviewCount("Клиентские приложения"),
                backend: overviewCount("Серверные приложения"),
                internal: overviewCount("Внутренние приложения"),
              })
              .describe("Разбиение по назначению; все ключи присутствуют"),
          })
          .describe("Приложения-реализаторы"),
        featureImplementations: implementationCountsSchema("реализации фич (FI)"),
        scenarioImplementations: implementationCountsSchema("реализации сценариев (SI)"),
      })
      .describe("Продуктовые знания; технические составы scope не считаются сущностями"),
    boards: z
      .strictObject({
        total: overviewCount("Все доски проекта, включая пустые"),
        byKind: z
          .strictObject({
            product: overviewCount("Доска продукта"),
            application: overviewCount("Доски приложений"),
            infrastructure: overviewCount("Доска инфраструктуры"),
          })
          .describe("Разбиение досок по области; все ключи присутствуют"),
        catalog: overviewPreview(
          overviewBoardSchema,
          "досок в порядке каталога: продукт, приложения по созданию, инфраструктура",
        ),
      })
      .describe("Доски проекта"),
    tasks: z
      .strictObject({
        total: overviewCount("Все задачи проекта на всех досках"),
        byColumn: taskColumnCountsSchema,
        completed: overviewCount(
          "Фактически выполненные: done, все критерии и обязательства; пересекается с byColumn",
        ),
        doneWithOpenObligations: overviewCount(
          "В колонке done, но критерии или обязательства сейчас не выполнены",
        ),
        readyToStart: overviewCount("Можно брать в работу: колонка ready и нет блокеров"),
        blocked: overviewCount(
          "Есть невыполненные прямые зависимости или подзадачи, в любой колонке",
        ),
        criteria: z
          .strictObject({
            total: overviewCount("Все критерии задач вне колонки cancelled"),
            completed: overviewCount("Выполненные критерии задач вне cancelled"),
            pending: overviewCount("Невыполненные критерии задач вне cancelled"),
            tasksWithPending: overviewCount("Задачи вне cancelled с невыполненными критериями"),
          })
          .describe("Критерии приёмки; критерии отменённых задач не учитываются"),
      })
      .describe(
        "Статистика задач; completed, readyToStart, blocked и критерии пересекаются и не складываются в total",
      ),
    attention: z
      .strictObject({
        inProgress: overviewPreview(
          overviewTaskSchema,
          "задач в колонке in-progress, новые изменения первыми",
        ),
        review: overviewPreview(
          overviewTaskSchema,
          "задач в колонке review, новые изменения первыми",
        ),
        blocked: overviewPreview(
          overviewTaskSchema,
          "заблокированных задач: in-progress, review, ready, inbox, done, cancelled, затем новые изменения",
        ),
      })
      .describe("Требует внимания: только данные существующей модели, без приоритетов и сроков"),
    documents: z
      .strictObject({
        total: overviewCount("Все документы, включая архивные"),
        byStatus: z
          .strictObject({
            draft: overviewCount("Черновики"),
            active: overviewCount("Действующие документы"),
            archived: overviewCount("Архивные документы"),
          })
          .describe("Разбиение по состоянию публикации; все ключи присутствуют"),
        pinned: overviewCount("Закреплённые документы в любом состоянии"),
        sections: z
          .strictObject({
            total: overviewCount("Настроенные разделы библиотеки"),
            unsectioned: overviewCount("Документы без раздела или с ненастроенным разделом"),
            items: z
              .array(
                z
                  .strictObject({
                    id: z.string().describe("Постоянный ID раздела"),
                    name: z.string().describe("Название раздела"),
                    documents: overviewCount("Документы раздела, включая архивные"),
                  })
                  .describe("Раздел библиотеки"),
              )
              .max(100)
              .describe("Все разделы в порядке настройки, включая пустые"),
          })
          .describe("Разделы библиотеки документов"),
        pinnedActive: overviewPreview(
          overviewDocumentSchema,
          "закреплённых действующих документов, новые изменения первыми",
        ),
      })
      .describe("Библиотека документов; прикрепление документа не меняет готовность"),
    plans: z
      .strictObject({
        total: overviewCount("Все планы работ"),
        byStatus: z
          .strictObject({
            draft: overviewCount("Черновики планов"),
            active: overviewCount("Планы в работе"),
            completed: overviewCount("Завершённые планы по собственному статусу"),
            cancelled: overviewCount("Отменённые планы"),
          })
          .describe("Собственные статусы планов; все ключи присутствуют"),
        completedNotReady: overviewCount(
          "Завершённые по статусу планы, чей состав сейчас фактически не выполнен",
        ),
        active: overviewPreview(overviewPlanSchema, "активных планов, новые изменения первыми"),
      })
      .describe("Планы работ"),
    releases: z
      .strictObject({
        total: overviewCount("Все релизы проекта"),
        byStatus: z
          .strictObject({
            planned: overviewCount("Запланированные релизы"),
            released: overviewCount("Выпущенные релизы"),
            cancelled: overviewCount("Отменённые релизы"),
          })
          .describe("Собственные статусы релизов; все ключи присутствуют"),
        upcoming: overviewPreview(
          overviewReleaseSchema,
          "запланированных релизов: ближайшая плановая дата, затем без даты",
        ),
        recent: overviewPreview(overviewReleaseSchema, "выпущенных релизов, последние первыми"),
      })
      .describe("Релизы проекта"),
    operator: productOverviewOperatorSchema,
  })
  .describe("Согласованный срез проекта из одного чтения");

const productOverviewItemSchema = z
  .strictObject({
    id: productIdSchema.describe("Постоянный ID записи продукта"),
    key: productKeySchema.optional().describe("Читаемый ключ записи, если назначен"),
    revision: z.number().describe("Ревизия записи"),
    kind: z
      .string()
      .describe("Вид записи: passport, feature, scenario, application, scope или document"),
    name: z.string().describe("Название записи; для состава реализации — служебная подпись"),
    summary: z.string().describe("Краткое описание; может быть пустым"),
  })
  .describe("Элемент карты продукта");

export const productOverviewSchema = z
  .strictObject({
    productId: z.string().describe("Постоянный ID продукта хранилища"),
    version: z
      .string()
      .describe("Версия продуктового состава: только записи продукта, без задач, планов и релизов"),
    items: z
      .array(productOverviewItemSchema)
      .describe("Полная карта продуктовых записей; клиент может листать её отдельно"),
    readiness: z.array(productReadinessSchema).describe("Готовность фич и сценариев по задачам"),
    snapshotVersion: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe(
        "Отпечаток всех данных среза: проект, паспорт, продукт, доски, задачи и критерии, документы, планы, релизы; не зависит от generatedAt",
      ),
    generatedAt: timestampSchema.describe("Время формирования ответа; не входит в snapshotVersion"),
    snapshot: productOverviewSnapshotSchema,
  })
  .describe("Обзор продукта: прежняя карта и общий согласованный срез проекта");

/** Детализация метрик оператора: та же классификация, что в snapshot.operator. */
export const productOverviewMetrics = [
  "review-obligations-met",
  "review-obligations-open",
  "blocker-impact",
  "blocker-affected",
  "unplanned-work",
  "board-work",
  "open-plans-complete",
  "ready-releases",
  "plans-outside-releases",
] as const;
export const productOverviewMetricSchema = z
  .enum(productOverviewMetrics)
  .describe(
    "Метрика обзора: review-obligations-met/open — группы проверки (M-01); blocker-impact — прямые блокеры, blocker-affected — задачи одного блокера (M-02); unplanned-work — работа вне открытых планов (M-03); board-work — доски (M-04); open-plans-complete — открытые планы с выполненным составом (M-05); ready-releases и plans-outside-releases — подготовка выпуска (M-06)",
  );
/** Размер страницы детализации по умолчанию. */
export const PRODUCT_OVERVIEW_METRIC_DEFAULT_LIMIT = 20;
/** Query детализации без метрики: метрика передаётся сегментом пути REST. */
export const productOverviewMetricPageQuerySchema = z.strictObject({
  blocker: boardTaskReferenceSchema
    .optional()
    .describe(
      "ID или ключ задачи-блокера; обязателен только для blocker-affected и запрещён для остальных метрик",
    ),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(PRODUCT_OVERVIEW_METRIC_DEFAULT_LIMIT)
    .describe("Размер страницы: 20 по умолчанию, максимум 100"),
  cursor: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe(
      "Непрозрачное продолжение из nextCursor; действует только для той же метрики, проекта, блокера и неизменного среза",
    ),
  version: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
    .describe(
      "snapshotVersion отображаемого обзора; при несовпадении с текущим срезом — VERSION_CONFLICT",
    ),
});
export const productOverviewMetricQuerySchema = productOverviewMetricPageQuerySchema.extend({
  metric: productOverviewMetricSchema,
});

const overviewBlockerAddressSchema = overviewTaskRefSchema
  .extend({ board: overviewTaskBoardSchema })
  .describe("Блокер, чей состав затронутых задач раскрыт");

const noBlockerSchema = z.null().describe("Блокер не применяется к этой метрике");
const metricPage = <
  M extends (typeof productOverviewMetrics)[number],
  T extends z.ZodType,
  B extends z.ZodType = typeof noBlockerSchema,
>(
  metric: M,
  item: T,
  blocker: B = noBlockerSchema as unknown as B,
) =>
  z
    .strictObject({
      metric: z.literal(metric).describe("Раскрытая метрика"),
      blocker,
      snapshotVersion: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .describe("Версия полного среза, на котором построена страница"),
      generatedAt: timestampSchema.describe("Время формирования ответа"),
      total: overviewCount("Полное число элементов метрики независимо от страницы"),
      items: z.array(item).max(100).describe("Элементы страницы в порядке метрики"),
      nextCursor: z
        .string()
        .nullable()
        .describe("Продолжение того же неизменного среза либо null в конце"),
    })
    .describe(`Страница метрики ${metric}`);

export const productOverviewMetricPageSchema = z
  .discriminatedUnion("metric", [
    metricPage("review-obligations-met", overviewOperatorTaskSchema),
    metricPage("review-obligations-open", overviewOperatorTaskSchema),
    metricPage("blocker-impact", overviewBlockerImpactSchema),
    metricPage("blocker-affected", overviewAffectedTaskSchema, overviewBlockerAddressSchema),
    metricPage("unplanned-work", overviewOperatorTaskSchema),
    metricPage("board-work", overviewBoardWorkSchema),
    metricPage("open-plans-complete", overviewOperatorPlanSchema),
    metricPage("ready-releases", overviewReleaseSchema),
    metricPage("plans-outside-releases", overviewOperatorPlanSchema),
  ])
  .describe("Постраничная детализация метрики оператора обзора");
export type ProductListQuery = z.input<typeof productListQuerySchema>;
export type ProductList = z.infer<typeof productListSchema>;
export type ProductOverview = z.infer<typeof productOverviewSchema>;
export type ProductOverviewSnapshot = z.infer<typeof productOverviewSnapshotSchema>;
export type ProductOverviewOperator = z.infer<typeof productOverviewOperatorSchema>;
export type ProductOverviewMetric = z.infer<typeof productOverviewMetricSchema>;
export type ProductOverviewMetricQuery = z.input<typeof productOverviewMetricQuerySchema>;
export type ProductOverviewMetricPage = z.infer<typeof productOverviewMetricPageSchema>;
export type ProductRecord = z.infer<typeof productRecordSchema>;
export type ProductFields = z.infer<typeof productFieldsSchema>;
export type ProductMutation = z.infer<typeof productMutationSchema>;
export type ProductState = z.infer<typeof productStateSchema>;
export type ProductContract = z.infer<typeof productContractSchema>;
export type ProductReference = z.infer<typeof productReferenceSchema>;
export type ProductStatus = z.infer<typeof productStatusSchema>;
export type ProductSaved = z.infer<typeof productSavedSchema>;
export type ProductContextQuery = z.infer<typeof productContextQuerySchema>;
export type ProductContext = z.infer<typeof productContextSchema>;
