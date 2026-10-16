import { z } from "zod";
import { entityRefSchema } from "./entities.js";
import {
  workHistoryIdSchema,
  workSessionKeySchema,
  workSessionStatusSchema,
  workHistoryEventKindSchema,
} from "./work-history-primitives.js";
export {
  workHistoryIdSchema,
  workSessionKeySchema,
  workSessionStatusSchema,
  workHistoryEventKindSchema,
} from "./work-history-primitives.js";
import {
  actorSchema,
  entityReferenceSchema,
  requestIdSchema,
  singleLine,
  text,
  timestampSchema,
} from "./primitives.js";

export const WORK_HISTORY_CAPABILITY = "relay-work-history-v1" as const;
export const WORK_HISTORY_OWNER_KINDS = ["work-session", "agent-run", "work-checkpoint"] as const;

export const agentRunKeySchema = z
  .string()
  .regex(/^RUN-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .describe(
    "Собственный адрес участия: RUN- и безопасный случайный token; прежние числовые ключи допустимы",
  );
export const workCheckpointKeySchema = z
  .string()
  .regex(/^CP-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .describe(
    "Собственный адрес точки: CP- и безопасный случайный token; прежние числовые ключи допустимы",
  );

export const workOperatorSchema = z
  .strictObject({
    name: text(1024)
      .nullable()
      .describe("Имя человека от имени которого работает агент; null, если неизвестно"),
    email: text(1024)
      .nullable()
      .describe(
        "Email из источника атрибуции; null, если неизвестен; не глобальный ID и не подтверждённая личность",
      ),
    source: z
      .enum(["explicit", "environment", "git", "inherited"])
      .describe(
        "Источник сохранённой атрибуции: явный ввод, окружение клиента, Git клиента или наследование от родительского участия",
      ),
  })
  .describe("Снимок атрибуции человека при подключении, не учётная запись и не авторизация");
export const workGitSchema = z
  .strictObject({
    branch: text(1024)
      .nullable()
      .describe("Git-ветка рабочей копии клиента; null, если неизвестна или HEAD отсоединён"),
    commit: text(1024)
      .nullable()
      .describe("Git commit рабочей копии клиента на момент подключения; null, если неизвестен"),
  })
  .describe("Снимок Git-контекста клиента; сервер и Core не читают собственный Git вместо клиента");

const sequenceSchema = z.number().int().positive().describe("Номер точки хронологии ветки");
const countSchema = z.number().int().nonnegative().describe("Полное число записей");
const revisionSchema = z.number().int().positive().describe("Ревизия логической ветки работы");
const markdownSchema = text(256 * 1024).describe("Полный Markdown без обрезки и нормализации");
const outputTitleSchema = text(1024)
  .refine(
    (value) => value.trim().length > 0 && !/[\p{Cc}\u2028\u2029]/u.test(value),
    "Нужен непустой однострочный заголовок",
  )
  .describe("Полное однострочное название");
const outputActorSchema = text(512)
  .pipe(z.string().min(1).max(128))
  .describe("Сохранённый автор; не признак подключения к сети");
const sessionRefSchema = entityReferenceSchema.describe(
  "Ключ S-token, ID или адрес work-session:ID ветки",
);
const checkpointRefSchema = entityReferenceSchema.describe(
  "Ключ CP-token, ID или адрес work-checkpoint:ID точки",
);

export const agentRunEndReasonSchema = z
  .enum(["completed", "paused", "transferred", "cancelled"])
  .describe("Причина окончания участия: завершение, пауза, передача или отмена");
export const workCheckpointKindSchema = z
  .enum(["intent", "progress", "result", "cancel"])
  .describe("Открытие намерения, промежуточный материал, результат или отмена намерения");

export const workSessionSchema = z
  .strictObject({
    id: workHistoryIdSchema.describe("Постоянный ID логической ветки"),
    key: workSessionKeySchema,
    title: outputTitleSchema.describe("Название поручения"),
    description: markdownSchema.describe("Полный текст поручения в Markdown"),
    parentSessionId: workHistoryIdSchema
      .nullable()
      .describe("Неизменяемый ID родителя; null у корня"),
    originCheckpointId: workHistoryIdSchema
      .nullable()
      .describe("ID исходного intent родителя; null у корня"),
    createdByRunId: workHistoryIdSchema
      .nullable()
      .describe("ID участия, создавшего дочернюю ветку; null у корня"),
    parentSequence: sequenceSchema
      .nullable()
      .describe("Сохранённый номер fork в хронологии родителя; null у корня"),
    status: workSessionStatusSchema,
    currentRunId: workHistoryIdSchema
      .nullable()
      .describe("ID единственного текущего участия; null вне open; не признак online"),
    sequence: sequenceSchema.describe(
      "Последний выделенный номер точки хронологии этой ветки; только возрастает",
    ),
    result: markdownSchema.describe(
      "Итог завершения или причина отмены; пустая строка до закрытия",
    ),
    createdAt: timestampSchema.describe("Время создания ветки"),
    updatedAt: timestampSchema.describe("Время последнего изменения ветки"),
    closedAt: timestampSchema
      .nullable()
      .describe("Время завершения или отмены; null у незакрытой ветки"),
    revision: revisionSchema,
  })
  .describe("Логическая ветка работы, живущая дольше отдельного участия агента");

export const agentRunSchema = z
  .strictObject({
    id: workHistoryIdSchema.describe("Постоянный ID участия агента"),
    key: agentRunKeySchema,
    sessionId: workHistoryIdSchema.describe("ID ветки участия"),
    actor: outputActorSchema,
    operator: workOperatorSchema
      .nullable()
      .describe("Сохранённая атрибуция человека; null при отсутствии данных; не авторизация"),
    git: workGitSchema
      .nullable()
      .describe("Git-контекст рабочей копии клиента; null при отсутствии данных"),
    client: text(1024).nullable().describe("Название клиента; null, если не передано"),
    sourceSessionId: text(1024)
      .nullable()
      .describe("Внешний ID сессии клиента; null, если не передан; не ID ветки Relay"),
    startedAt: timestampSchema.describe("Время сохранённого подключения агента"),
    endedAt: timestampSchema
      .nullable()
      .describe("Время окончания участия; null у текущего участия"),
    startedSequence: sequenceSchema.describe("Номер подключения в хронологии ветки"),
    endedSequence: sequenceSchema
      .nullable()
      .describe("Номер окончания участия в ветке; null до окончания"),
    endReason: agentRunEndReasonSchema
      .nullable()
      .describe("Способ окончания участия; null до окончания"),
    predecessorRunId: workHistoryIdSchema
      .nullable()
      .describe("ID предыдущего участия той же ветки; null у первого"),
    reason: markdownSchema.describe(
      "Объяснение подключения или передачи, сохранённое при создании участия",
    ),
    endSummary: markdownSchema
      .nullable()
      .describe(
        "Сохранённое объяснение окончания участия; null до окончания; исходная reason не перезаписывается",
      ),
  })
  .describe(
    "Отдельное участие агента; активность не подтверждает online и не использует heartbeat",
  );

export const workHistoryReferenceSchema = z
  .strictObject({
    ref: entityRefSchema.describe("Постоянный адрес упомянутой предметной сущности"),
    key: z
      .string()
      .nullable()
      .describe("Ключ цели на момент сохранения; null при отсутствии ключа"),
    title: z
      .string()
      .describe("Название цели на момент сохранения; не перечитывается из текущей сущности"),
  })
  .describe("Сохранённая подпись ссылки, но не снимок содержания целевой сущности");

export const agentRunSummarySchema = agentRunSchema
  .omit({ reason: true, endSummary: true })
  .describe("Участие без больших Markdown; автор, атрибуция, Git-контекст и состояние сохраняются");
export const workSessionAcceptanceSchema = z
  .strictObject({
    checkpointId: workHistoryIdSchema.describe(
      "ID первой точки родителя, явно принявшей результат завершённого ребёнка",
    ),
    checkpointKey: workCheckpointKeySchema.describe(
      "Сохранённый ключ первой принимающей точки родителя",
    ),
    sessionId: workHistoryIdSchema.describe("ID родительской ветки, принявшей результат"),
    runId: workHistoryIdSchema.describe(
      "ID участия родителя, впервые принявшего результат ребёнка",
    ),
    at: timestampSchema.describe("Время сохранения первой принимающей точки"),
  })
  .describe(
    "Явное первое принятие результата ребёнка; не выводится из completed без принимающей точки",
  );

const checkpointContentShape = {
  title: outputTitleSchema.describe("Название точки работы"),
  summary: text(16 * 1024).describe("Полное краткое описание обычным текстом"),
  body: markdownSchema.describe("Основной материал точки в Markdown"),
  done: markdownSchema.describe("Что сделано, в Markdown; пустая строка при отсутствии"),
  remaining: markdownSchema.describe(
    "Что осталось и что блокирует, в Markdown; пустая строка при отсутствии",
  ),
  nextStep: markdownSchema.describe("Следующее действие в Markdown; пустая строка при отсутствии"),
  checks: markdownSchema.describe(
    "Проверки и их фактические результаты в Markdown; пустая строка при отсутствии",
  ),
  references: z
    .array(workHistoryReferenceSchema)
    .max(100)
    .describe("Подписи ссылок, сохранённые вместе с этой точкой"),
};
const checkpointShape = {
  id: workHistoryIdSchema.describe("Постоянный ID неизменяемой точки"),
  key: workCheckpointKeySchema,
  sessionId: workHistoryIdSchema.describe("ID ветки, в которой сохранена точка"),
  runId: workHistoryIdSchema.describe("ID участия, создавшего точку"),
  sequence: sequenceSchema,
  ...checkpointContentShape,
  createdAt: timestampSchema.describe("Время сохранения точки"),
  createdBy: outputActorSchema.describe("Автор сохранения точки"),
};
export const workCheckpointSchema = z
  .discriminatedUnion("kind", [
    z
      .strictObject({
        ...checkpointShape,
        kind: z.literal("intent").describe("Открытие нового намерения"),
        intentId: z.null().describe("У самого намерения нет исходного intent"),
        acceptedSessionIds: z
          .array(workHistoryIdSchema)
          .max(0)
          .describe("У открытия намерения список принятия всегда пуст"),
      })
      .describe("Неизменяемое открытие намерения; состояние вычисляется по последующим точкам"),
    z
      .strictObject({
        ...checkpointShape,
        kind: z
          .enum(["progress", "result", "cancel"])
          .describe("Промежуточный материал либо отдельная закрывающая запись"),
        intentId: workHistoryIdSchema.describe("ID исходного открытого намерения этой же ветки"),
        acceptedSessionIds: z
          .array(workHistoryIdSchema)
          .max(100)
          .describe(
            "Явно принятые результаты завершённых прямых детей, привязанных к этому intent; не выводятся из статуса ребёнка",
          ),
      })
      .describe("Неизменяемый материал намерения; result и cancel закрывают intent"),
  ])
  .describe("Точка истории работы; не журнал вызовов и не история содержимого других сущностей");

export const workSessionSummarySchema = workSessionSchema
  .omit({ description: true, result: true })
  .describe("Обзор ветки без поручения и итогового Markdown; полные тексты доступны через get");
export const workSessionCountsSchema = z
  .strictObject({
    runs: countSchema.describe("Все участия самой ветки"),
    checkpoints: countSchema.describe("Все точки самой ветки"),
    openIntents: countSchema.describe("Все незакрытые intent самой ветки"),
    children: countSchema.describe("Все прямые дочерние ветки"),
    unfinishedChildren: countSchema.describe("Прямые дети в pending, open или paused"),
  })
  .describe("Полные счётчики, а не число элементов страницы");
export const workSessionDetailSchema = z
  .strictObject({
    session: workSessionSchema.describe("Полная карточка ветки с поручением и итогом"),
    currentRun: agentRunSchema
      .nullable()
      .describe("Текущее участие либо null; не проверка присутствия агента"),
    counts: workSessionCountsSchema,
    latestRun: agentRunSummarySchema
      .nullable()
      .describe(
        "Последнее участие даже у paused/completed/cancelled; null, если участия ещё не было",
      ),
    acceptance: workSessionAcceptanceSchema
      .nullable()
      .describe(
        "Первое принятие результата родителем; null у непринятого или неприменимого, различайте по parentSessionId/status",
      ),
  })
  .describe("Полная карточка ветки и счётчики без скрыто усечённых списков");

export const workSessionOverviewSchema = workSessionSummarySchema
  .extend({
    counts: workSessionCountsSchema,
    latestRun: agentRunSummarySchema
      .nullable()
      .describe("Последнее участие ветки без больших Markdown; null, если участия ещё не было"),
    acceptance: workSessionAcceptanceSchema
      .nullable()
      .describe("Первое явное принятие результата родителем; null у непринятого или неприменимого"),
  })
  .describe(
    "Обзор для list/tree: компактная ветка, полные собственные счётчики, последнее участие и принятие",
  );

export const workHistoryPageQuerySchema = z
  .strictObject({
    offset: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("Смещение страницы; по умолчанию 0"),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe("Размер страницы: по умолчанию 20, максимум 100"),
    version: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        "Непрозрачная версия первой страницы; передавайте при продолжении, изменение даёт VERSION_CONFLICT",
      ),
  })
  .describe("Страница текущего состояния; version не открывает исторический снимок");
const pageShape = {
  total: countSchema.describe("Полное число элементов выбранной области до пагинации"),
  nextOffset: countSchema.nullable().describe("Смещение продолжения либо null, если прочитано всё"),
  version: z
    .string()
    .min(1)
    .max(256)
    .describe("Непрозрачная версия состава и фильтров чтения; не исторический снимок"),
};
export const workSessionsQuerySchema = workHistoryPageQuerySchema
  .extend({
    unfinished: z
      .boolean()
      .optional()
      .describe(
        "true — только pending/open/paused; false — только completed/cancelled; отсутствие — все",
      ),
    status: workSessionStatusSchema.optional().describe("Дополнительный фильтр состояния ветки"),
    parent: sessionRefSchema
      .nullable()
      .optional()
      .describe("Прямые дети выбранного родителя; null — только корни; отсутствие — все ветки"),
    actor: actorSchema.optional().describe("Автор хотя бы одного сохранённого участия ветки"),
    q: text(1024).optional().describe("Поиск по ключу, названию и поручению ветки"),
  })
  .describe("Найти ветки работы; фильтры применяются совместно");
export const workSessionQuerySchema = z
  .strictObject({ ref: sessionRefSchema })
  .describe("Прочитать одну ветку работы");
export const workCheckpointQuerySchema = z
  .strictObject({ ref: checkpointRefSchema })
  .describe("Прочитать одну неизменяемую точку целиком");
export const workTreeQuerySchema = workHistoryPageQuerySchema
  .extend({
    ref: sessionRefSchema,
  })
  .describe(
    "Дерево выбранной ветки произвольной глубины, включая корень; прямой обход с детьми по createdAt и ID",
  );
export const workTreeNodeSchema = z
  .strictObject({
    session: workSessionOverviewSchema,
    parentSessionId: workHistoryIdSchema
      .nullable()
      .describe("Фактический родитель ветки, в том числе вне страницы или выбранного поддерева"),
    depth: countSchema.describe("Глубина относительно выбранного корня; корень имеет глубину 0"),
  })
  .describe("Узел страницы дерева; отсутствие родителя на странице не делает узел корнем");
export const workTreeTotalsSchema = z
  .strictObject({
    sessions: countSchema.describe("Все ветки поддерева, включая выбранный корень"),
    unfinished: countSchema.describe("Все незакрытые ветки поддерева"),
    runs: countSchema.describe("Все участия всех веток поддерева"),
    checkpoints: countSchema.describe("Все точки всех веток поддерева"),
    openIntents: countSchema.describe("Все открытые намерения всех веток поддерева"),
  })
  .describe("Счётчики полного поддерева, не страницы");
export const workTreePageSchema = z
  .strictObject({
    rootSessionId: workHistoryIdSchema.describe("Постоянный ID выбранного корня"),
    items: z.array(workTreeNodeSchema).describe("Узлы страницы в порядке прямого обхода дерева"),
    totals: workTreeTotalsSchema,
    ...pageShape,
  })
  .describe("Страница дерева с полными счётчиками поддерева");

export const workSessionsPageSchema = z
  .strictObject({
    items: z
      .array(workSessionOverviewSchema)
      .describe("Обзоры веток страницы; порядок updatedAt по убыванию, затем ID"),
    projectTotals: workTreeTotalsSchema.describe(
      "Счётчики ВСЕГО проекта независимо от фильтров и страницы; total отдельно считает отфильтрованные ветки",
    ),
    ...pageShape,
  })
  .describe("Страница найденных веток с обзором каждого элемента и полными счётчиками проекта");

export const workOpenIntentsQuerySchema = workHistoryPageQuerySchema
  .extend({
    ref: sessionRefSchema,
    includeChildren: z
      .boolean()
      .default(false)
      .describe(
        "Включить открытые intent всех потомков выбранной ветки; по умолчанию только сама ветка",
      ),
  })
  .describe(
    "Найти все незакрытые намерения без скачивания всей истории; состояние вычисляется по terminal checkpoints",
  );
export const workOpenIntentsPageSchema = z
  .strictObject({
    items: z
      .array(workCheckpointSchema.options[0])
      .describe(
        "Только незакрытые intent выбранной страницы с полным Markdown; порядок createdAt, sessionId, sequence, id по возрастанию",
      ),
    ...pageShape,
  })
  .describe(
    "Страница открытых намерений; result/cancel исключают intent из выборки, progress не закрывает его",
  );

const historyItemShape = {
  id: z
    .string()
    .min(1)
    .describe("Стабильный производный ID точки хронологии; не ID отдельной записи event-store"),
  sessionId: workHistoryIdSchema.describe("Ветка, чья хронология содержит точку"),
  sequence: sequenceSchema,
  at: timestampSchema.describe("Сохранённое время события, а не время чтения"),
};
export const workHistoryItemSchema = z
  .discriminatedUnion("kind", [
    z
      .strictObject({
        ...historyItemShape,
        kind: z.enum(["session-created", "session-closed"]).describe("Создание или закрытие ветки"),
        session: workSessionSchema.describe(
          "Полная текущая ветка — не историческая ревизия её карточки",
        ),
      })
      .describe("Производная точка жизненного цикла ветки"),
    z
      .strictObject({
        ...historyItemShape,
        kind: z.literal("session-forked").describe("Создание дочерней ветки в хронологии родителя"),
        childSession: workSessionSchema.describe(
          "Полная текущая дочерняя ветка — не историческая ревизия",
        ),
      })
      .describe("Сохранённое ответвление от намерения родителя"),
    z
      .strictObject({
        ...historyItemShape,
        kind: z
          .enum(["run-started", "run-ended"])
          .describe("Начало или окончание сохранённого участия"),
        run: agentRunSchema.describe(
          "Сохранённое участие; окончание может быть заполнено уже после начала",
        ),
      })
      .describe("Подключение или отключение участника, не сетевой сигнал присутствия"),
    z
      .strictObject({
        ...historyItemShape,
        kind: z.literal("checkpoint").describe("Сохранённая точка работы"),
        checkpoint: workCheckpointSchema.describe("Полное неизменяемое содержание точки"),
      })
      .describe("Намерение или материал его исполнения"),
  ])
  .describe("Хронология по (at, sessionId, sequence, id); при desc порядок целиком обращается");
export const workHistoryQuerySchema = workHistoryPageQuerySchema
  .extend({
    ref: sessionRefSchema
      .optional()
      .describe("Выбранная ветка; отсутствие — история всего проекта"),
    includeChildren: z
      .boolean()
      .default(false)
      .describe("Включить всех потомков выбранной ветки; без ref история уже включает весь проект"),
    order: z
      .enum(["asc", "desc"])
      .default("desc")
      .describe("Направление устойчивой хронологии: asc — сначала старые, desc — сначала новые"),
    kind: workHistoryEventKindSchema
      .optional()
      .describe("Ограничить страницу типом точки хронологии"),
  })
  .describe("Объединённая история сохранённых подключений, fork, завершений и checkpoints");
export const workHistoryPageSchema = z
  .strictObject({
    items: z
      .array(workHistoryItemSchema)
      .describe("Полные материалы только выбранной страницы истории"),
    ...pageShape,
  })
  .describe("Страница производной истории с явным продолжением");
export const workContextQuerySchema = workHistoryPageQuerySchema
  .extend({
    ref: sessionRefSchema,
  })
  .describe(
    "Полная карточка и страница последних материалов самой ветки, без потомков; порядок desc",
  );
export const workContextSchema = workSessionDetailSchema
  .extend({
    history: workHistoryPageSchema.describe(
      "Ограниченная страница истории; total и nextOffset явно показывают непрочитанное; продолжение через context с теми же параметрами",
    ),
  })
  .describe("Контекст ветки; поручение и результат полные, история не выдаётся за исчерпывающую");

const mutationShape = {
  requestId: requestIdSchema,
  actor: actorSchema
    .optional()
    .describe(
      "Автор операции; при отсутствии используется defaultActor вызова; не механизм авторизации",
    ),
};
const branchMutationShape = {
  ...mutationShape,
  ref: sessionRefSchema,
  ifRevision: revisionSchema.describe(
    "Исходная ревизия ВЕТКИ, а не run или checkpoint; конфликт отменяет всю мутацию",
  ),
};
const ownerMutationShape = {
  ...branchMutationShape,
  runId: workHistoryIdSchema.describe(
    "Постоянный ID текущего участия-владельца ветки, не ключ RUN-N",
  ),
};
const connectionShape = {
  operator: workOperatorSchema
    .nullable()
    .optional()
    .describe(
      "Атрибуция от клиента; отсутствие при attach допускает наследование из createdByRun родителя, null явно оставляет атрибуцию неизвестной",
    ),
  git: workGitSchema
    .nullable()
    .optional()
    .describe(
      "Git-контекст от клиента; отсутствие или null означает неизвестный контекст, сервер его не вычисляет",
    ),
  client: singleLine(1024)
    .optional()
    .describe("Название клиента; отсутствие сохраняется как null в новом run"),
  sourceSessionId: singleLine(1024)
    .optional()
    .describe("Внешний ID сессии клиента; отсутствие сохраняется как null в новом run"),
  reason: markdownSchema
    .default("")
    .describe("Причина подключения в Markdown; по умолчанию пустая строка"),
};
const assignmentShape = {
  title: singleLine(1024).describe("Непустое однострочное название поручения"),
  description: markdownSchema
    .default("")
    .describe("Полное поручение в Markdown; по умолчанию пустая строка"),
};
export const workSessionStartSchema = z
  .strictObject({
    ...mutationShape,
    ...assignmentShape,
    ...connectionShape,
  })
  .describe("Создать корневую open-ветку и первое участие атомарно; CAS отсутствует");
export const workSessionForkSchema = z
  .strictObject({
    ...ownerMutationShape,
    ref: checkpointRefSchema.describe(
      "Открытый intent родительской ветки: CP-N, ID или work-checkpoint:ID; ifRevision относится к родительской ветке, runId — к её текущему участию",
    ),
    ...assignmentShape,
  })
  .describe(
    "Создать pending-ребёнка из открытого intent до запуска субагента; run ребёнка не создаётся",
  );
export const workSessionAttachSchema = z
  .strictObject({
    ...branchMutationShape,
    ...connectionShape,
  })
  .describe("Подключиться к pending-ветке под её CAS и создать первое участие");
export const workSessionPauseSchema = z
  .strictObject({
    ...ownerMutationShape,
    reason: markdownSchema
      .refine((value) => value.trim().length > 0, "Нужна причина паузы")
      .describe("Непустое объяснение паузы; сохраняется как материал окончания участия"),
  })
  .describe(
    "Завершить текущее участие с причиной paused и приостановить ветку; intent остаются открытыми",
  );
export const workSessionResumeSchema = z
  .strictObject({
    ...branchMutationShape,
    ...connectionShape,
  })
  .describe("Возобновить paused-ветку под её CAS; создать новый run с predecessorRunId");
export const workSessionTakeoverSchema = z
  .strictObject({
    ...branchMutationShape,
    ...connectionShape,
    reason: markdownSchema
      .refine((value) => value.trim().length > 0, "Нужна причина передачи")
      .describe("Непустая причина явной передачи участия; сохраняется в новом run"),
  })
  .describe("Явно заменить текущий run open-ветки под её CAS; прежний заканчивается с transferred");
export const workSessionCompleteSchema = z
  .strictObject({
    ...ownerMutationShape,
    result: markdownSchema
      .refine((value) => value.trim().length > 0, "Нужен итог работы")
      .describe("Непустой итог всей ветки в Markdown"),
  })
  .describe(
    "Завершить ветку и run; Core проверяет незакрытые intent и непринятые результаты детей",
  );
export const workSessionCancelSchema = z
  .strictObject({
    ...branchMutationShape,
    runId: workHistoryIdSchema
      .optional()
      .describe("ID текущего run обязателен для open-ветки; у pending/paused текущего run нет"),
    result: markdownSchema
      .refine((value) => value.trim().length > 0, "Нужна причина отмены")
      .describe("Непустая причина отмены всей ветки в Markdown"),
  })
  .describe(
    "Отменить ветку без неявного принятия детей; Core проверяет открытые intent и незакрытых детей",
  );

const checkpointInputShape = {
  title: singleLine(1024).describe("Название новой неизменяемой точки"),
  summary: checkpointContentShape.summary
    .default("")
    .describe("Краткое описание; по умолчанию пустая строка"),
  body: markdownSchema
    .refine((value) => value.trim().length > 0, "Нужен непустой Markdown намерения или результата")
    .describe(
      "Обязательный непустой полный Markdown намерения или результата; переводы строк и пробелы сохраняются без преобразований",
    ),
  done: markdownSchema.default("").describe("Сделано, Markdown; по умолчанию пустая строка"),
  remaining: markdownSchema
    .default("")
    .describe("Остаток и блокеры, Markdown; по умолчанию пустая строка"),
  nextStep: markdownSchema
    .default("")
    .describe("Следующее действие, Markdown; по умолчанию пустая строка"),
  checks: markdownSchema
    .default("")
    .describe("Проверки и фактические результаты, Markdown; по умолчанию пустая строка"),
  references: z
    .array(
      entityReferenceSchema.describe(
        "Ключ, ID или kind:ID цели; Core разрешает адрес и сохраняет подпись",
      ),
    )
    .max(100)
    .default([])
    .describe(
      "Адреса целей для сохранённых подписей; не снимки содержания и не отношения общего графа",
    ),
};
export const workCheckpointOpenSchema = z
  .strictObject({
    ...ownerMutationShape,
    ...checkpointInputShape,
  })
  .describe("Открыть intent новой неизменяемой точкой в текущей ветке");
const checkpointMutationShape = {
  ...ownerMutationShape,
  ref: checkpointRefSchema.describe(
    "Адрес исходного открытого intent; ifRevision относится к его ВЕТКЕ, runId — к её текущему участию",
  ),
  ...checkpointInputShape,
  acceptedSessionIds: z
    .array(
      workHistoryIdSchema.describe("Постоянный ID завершённого прямого ребёнка исходного intent"),
    )
    .max(100)
    .default([])
    .describe("Явно принять указанные результаты детей; пустой список ничего не принимает"),
};
export const workCheckpointSaveSchema = z
  .strictObject(checkpointMutationShape)
  .describe(
    "Добавить progress к открытому intent; можно явно принять результаты детей, не закрывая intent",
  );
export const workCheckpointCompleteSchema = z
  .strictObject(checkpointMutationShape)
  .describe("Закрыть intent новой точкой result; исходная точка не изменяется");
export const workCheckpointCancelSchema = z
  .strictObject(checkpointMutationShape)
  .describe(
    "Закрыть intent новой точкой cancel; исходная точка не изменяется, принятие детей только явное",
  );
export const workHistoryMutationSchema = z
  .strictObject({
    session: workSessionSchema.describe(
      "Полная ветка после операции; при fork — родитель с новой ревизией",
    ),
    run: agentRunSchema
      .nullable()
      .describe(
        "Созданное или завершённое участие; для checkpoint/fork — текущее; null, если участия нет",
      ),
    checkpoint: workCheckpointSchema
      .nullable()
      .describe("Созданная точка либо null, если операция её не создаёт"),
    childSession: workSessionSchema
      .nullable()
      .describe("Созданная pending-ветка только при fork, иначе null"),
  })
  .describe(
    "Результат одной атомарной мутации; не постоянная квитанция и не гарантия дедупликации",
  );

/** Единые имена предметных операций и схемы; маршруты и конверты принадлежат адаптерам. */
export const workHistoryOperations = {
  list: { input: workSessionsQuerySchema, output: workSessionsPageSchema },
  get: { input: workSessionQuerySchema, output: workSessionDetailSchema },
  tree: { input: workTreeQuerySchema, output: workTreePageSchema },
  history: { input: workHistoryQuerySchema, output: workHistoryPageSchema },
  context: { input: workContextQuerySchema, output: workContextSchema },
  checkpoint: { input: workCheckpointQuerySchema, output: workCheckpointSchema },
  openIntents: { input: workOpenIntentsQuerySchema, output: workOpenIntentsPageSchema },
  start: { input: workSessionStartSchema, output: workHistoryMutationSchema },
  fork: { input: workSessionForkSchema, output: workHistoryMutationSchema },
  attach: { input: workSessionAttachSchema, output: workHistoryMutationSchema },
  pause: { input: workSessionPauseSchema, output: workHistoryMutationSchema },
  resume: { input: workSessionResumeSchema, output: workHistoryMutationSchema },
  takeover: { input: workSessionTakeoverSchema, output: workHistoryMutationSchema },
  complete: { input: workSessionCompleteSchema, output: workHistoryMutationSchema },
  cancel: { input: workSessionCancelSchema, output: workHistoryMutationSchema },
  openCheckpoint: { input: workCheckpointOpenSchema, output: workHistoryMutationSchema },
  saveCheckpoint: { input: workCheckpointSaveSchema, output: workHistoryMutationSchema },
  completeCheckpoint: { input: workCheckpointCompleteSchema, output: workHistoryMutationSchema },
  cancelCheckpoint: { input: workCheckpointCancelSchema, output: workHistoryMutationSchema },
} as const;

export type WorkSessionStatus = z.output<typeof workSessionStatusSchema>;
export type AgentRunEndReason = z.output<typeof agentRunEndReasonSchema>;
export type WorkCheckpointKind = z.output<typeof workCheckpointKindSchema>;
export type WorkSession = z.output<typeof workSessionSchema>;
export type AgentRun = z.output<typeof agentRunSchema>;
export type AgentRunSummary = z.output<typeof agentRunSummarySchema>;
export type WorkSessionAcceptance = z.output<typeof workSessionAcceptanceSchema>;
export type WorkSessionOverview = z.output<typeof workSessionOverviewSchema>;
export type WorkOpenIntentsQuery = z.input<typeof workOpenIntentsQuerySchema>;
export type WorkOpenIntentsPage = z.output<typeof workOpenIntentsPageSchema>;
export type WorkOperator = z.output<typeof workOperatorSchema>;
export type WorkGit = z.output<typeof workGitSchema>;
export type WorkCheckpoint = z.output<typeof workCheckpointSchema>;
export type WorkHistoryReference = z.output<typeof workHistoryReferenceSchema>;
export type WorkSessionSummary = z.output<typeof workSessionSummarySchema>;
export type WorkSessionCounts = z.output<typeof workSessionCountsSchema>;
export type WorkSessionDetail = z.output<typeof workSessionDetailSchema>;
export type WorkSessionsPage = z.output<typeof workSessionsPageSchema>;
export type WorkTreeNode = z.output<typeof workTreeNodeSchema>;
export type WorkTreeTotals = z.output<typeof workTreeTotalsSchema>;
export type WorkTreePage = z.output<typeof workTreePageSchema>;
export type WorkHistoryItem = z.output<typeof workHistoryItemSchema>;
export type WorkHistoryPage = z.output<typeof workHistoryPageSchema>;
export type WorkContext = z.output<typeof workContextSchema>;
export type WorkHistoryMutation = z.output<typeof workHistoryMutationSchema>;
export type WorkHistoryPageQuery = z.input<typeof workHistoryPageQuerySchema>;
export type WorkSessionsQuery = z.input<typeof workSessionsQuerySchema>;
export type WorkSessionQuery = z.input<typeof workSessionQuerySchema>;
export type WorkCheckpointQuery = z.input<typeof workCheckpointQuerySchema>;
export type WorkTreeQuery = z.input<typeof workTreeQuerySchema>;
export type WorkHistoryQuery = z.input<typeof workHistoryQuerySchema>;
export type WorkContextQuery = z.input<typeof workContextQuerySchema>;
export type WorkSessionStart = z.input<typeof workSessionStartSchema>;
export type WorkSessionFork = z.input<typeof workSessionForkSchema>;
export type WorkSessionAttach = z.input<typeof workSessionAttachSchema>;
export type WorkSessionPause = z.input<typeof workSessionPauseSchema>;
export type WorkSessionResume = z.input<typeof workSessionResumeSchema>;
export type WorkSessionTakeover = z.input<typeof workSessionTakeoverSchema>;
export type WorkSessionComplete = z.input<typeof workSessionCompleteSchema>;
export type WorkSessionCancel = z.input<typeof workSessionCancelSchema>;
export type WorkCheckpointOpen = z.input<typeof workCheckpointOpenSchema>;
export type WorkCheckpointSave = z.input<typeof workCheckpointSaveSchema>;
export type WorkCheckpointComplete = z.input<typeof workCheckpointCompleteSchema>;
export type WorkCheckpointCancel = z.input<typeof workCheckpointCancelSchema>;

/** Переносимая граница Core; адаптер Backend привязывает defaultActor к своему контексту. */
export interface WorkHistoryServiceContract {
  list(input: WorkSessionsQuery): Promise<WorkSessionsPage>;
  get(input: WorkSessionQuery): Promise<WorkSessionDetail>;
  tree(input: WorkTreeQuery): Promise<WorkTreePage>;
  history(input: WorkHistoryQuery): Promise<WorkHistoryPage>;
  context(input: WorkContextQuery): Promise<WorkContext>;
  checkpoint(input: WorkCheckpointQuery): Promise<WorkCheckpoint>;
  openIntents(input: WorkOpenIntentsQuery): Promise<WorkOpenIntentsPage>;
  start(input: WorkSessionStart, defaultActor: string): Promise<WorkHistoryMutation>;
  fork(input: WorkSessionFork, defaultActor: string): Promise<WorkHistoryMutation>;
  attach(input: WorkSessionAttach, defaultActor: string): Promise<WorkHistoryMutation>;
  pause(input: WorkSessionPause, defaultActor: string): Promise<WorkHistoryMutation>;
  resume(input: WorkSessionResume, defaultActor: string): Promise<WorkHistoryMutation>;
  takeover(input: WorkSessionTakeover, defaultActor: string): Promise<WorkHistoryMutation>;
  complete(input: WorkSessionComplete, defaultActor: string): Promise<WorkHistoryMutation>;
  cancel(input: WorkSessionCancel, defaultActor: string): Promise<WorkHistoryMutation>;
  openCheckpoint(input: WorkCheckpointOpen, defaultActor: string): Promise<WorkHistoryMutation>;
  saveCheckpoint(input: WorkCheckpointSave, defaultActor: string): Promise<WorkHistoryMutation>;
  completeCheckpoint(
    input: WorkCheckpointComplete,
    defaultActor: string,
  ): Promise<WorkHistoryMutation>;
  cancelCheckpoint(input: WorkCheckpointCancel, defaultActor: string): Promise<WorkHistoryMutation>;
}
