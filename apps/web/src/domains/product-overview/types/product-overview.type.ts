/** Колонка задачи в действующей модели доски. */
export type OverviewTaskColumn =
  "inbox" | "ready" | "in-progress" | "review" | "done" | "cancelled";

/** Фактическая готовность требования по задачам. */
export type OverviewReadiness = "none" | "partial" | "done";

/** Ограниченная подборка с полным числом записей проекта. */
export type OverviewPreview<Item> = {
  /** Полное число записей независимо от размера подборки. */
  total: number;
  /** Есть записи сверх показанных; полный список открывается каталогом. */
  hasMore: boolean;
  /** Показанные записи, не более пяти. */
  items: Item[];
};

/** Разбиение требований по фактической готовности. */
export type OverviewReadinessCounts = Record<OverviewReadiness, number>;

/** Паспорт продукта в обзоре. */
export type OverviewPassport =
  | {
      /** Паспорт ещё не создан. */
      state: "missing";
    }
  | {
      /** Паспорт существует: с summary или с фрагментом описания. */
      state: "filled" | "no-summary";
      /** Читаемый ключ продукта либо null. */
      key: string | null;
      /** Название продукта. */
      name: string;
      /** Ревизия паспорта. */
      revision: number;
      /** Время последнего изменения паспорта. */
      updatedAt: string;
      /** Краткая summary либо начало описания при пустой summary. */
      text: string;
      /** Текст является фрагментом описания, а не сохранённой summary. */
      isExcerpt: boolean;
      /** Фрагмент обрезан по пределу длины. */
      isTruncated: boolean;
    };

/** Реализации фич или сценариев. */
export type OverviewImplementations = {
  /** Все реализации, включая снятые. */
  total: number;
  /** Действующие реализации. */
  active: number;
  /** Снятые реализации; не влияют на готовность. */
  withdrawn: number;
  /** Готовность действующих реализаций. */
  byStatus: OverviewReadinessCounts;
};

/** Продуктовые знания проекта. */
export type OverviewKnowledge = {
  /** Фичи продукта. */
  features: { total: number; byStatus: OverviewReadinessCounts };
  /** Сценарии фич. */
  scenarios: { total: number; byStatus: OverviewReadinessCounts };
  /** Приложения-реализаторы. */
  applications: { total: number; byType: Record<"frontend" | "backend" | "internal", number> };
  /** Реализации фич. */
  featureImplementations: OverviewImplementations;
  /** Реализации сценариев. */
  scenarioImplementations: OverviewImplementations;
};

/** Доска проекта с числом задач. */
export type OverviewBoard = {
  /** Постоянный ID доски. */
  id: string;
  /** Префикс ключей задач доски. */
  prefix: string;
  /** Адрес доски в проекте. */
  slug: string;
  /** Область ответственности доски. */
  kind: "product" | "application" | "infrastructure";
  /** Название доски. */
  name: string;
  /** Все задачи доски. */
  taskCount: number;
  /** Задачи вне done и cancelled. */
  openTaskCount: number;
};

/** Краткий адрес задачи. */
export type OverviewTaskRef = {
  /** Постоянный ID задачи. */
  id: string;
  /** Ключ задачи с префиксом доски. */
  key: string;
  /** Заголовок задачи; может быть пустым. */
  title: string;
  /** Текущая колонка. */
  column: OverviewTaskColumn;
};

/** Задача, требующая внимания. */
export type OverviewTask = OverviewTaskRef & {
  /** Текущая доска задачи. */
  board: { slug: string; name: string };
  /** Фактически выполнена с учётом критериев и обязательств. */
  isCompleted: boolean;
  /** Прогресс критериев приёмки. */
  acceptance: { total: number; completed: number };
  /** Невыполненные зависимости и подзадачи. */
  blockers: {
    /** Все причины блокировки. */
    total: number;
    /** Первые причины блокировки. */
    items: (OverviewTaskRef & { relation: "dependency" | "subtask" })[];
  };
};

/** Статистика задач проекта; показатели пересекаются и не складываются. */
export type OverviewTasks = {
  /** Все задачи проекта. */
  total: number;
  /** Число задач в каждой из шести колонок. */
  byColumn: Record<OverviewTaskColumn, number>;
  /** Фактически выполненные задачи. */
  completed: number;
  /** В колонке done, но обязательства сейчас не выполнены. */
  doneWithOpenObligations: number;
  /** Можно брать в работу. */
  readyToStart: number;
  /** Есть невыполненные зависимости или подзадачи. */
  blocked: number;
  /** Критерии приёмки задач вне cancelled. */
  criteria: { total: number; completed: number; pending: number; tasksWithPending: number };
};

/** Закреплённый действующий документ. */
export type OverviewDocument = {
  /** Постоянный ID документа. */
  id: string;
  /** Читаемый ключ либо null. */
  key: string | null;
  /** Название документа. */
  name: string;
  /** Краткое описание; может быть пустым. */
  summary: string;
  /** Время последнего изменения. */
  updatedAt: string;
};

/** Библиотека документов проекта. */
export type OverviewDocuments = {
  /** Все документы, включая архивные. */
  total: number;
  /** Разбиение по состоянию публикации. */
  byStatus: Record<"draft" | "active" | "archived", number>;
  /** Закреплённые документы в любом состоянии. */
  pinned: number;
  /** Настроенные разделы и документы без раздела. */
  sections: { total: number; unsectioned: number };
  /** Закреплённые действующие документы. */
  pinnedActive: OverviewPreview<OverviewDocument>;
};

/** Статус плана работ. */
export type OverviewPlanStatus = "draft" | "active" | "completed" | "cancelled";

/** Активный план работ. */
export type OverviewPlan = {
  /** Постоянный ID плана. */
  id: string;
  /** Читаемый ключ плана. */
  key: string;
  /** Название плана. */
  title: string;
  /** Краткое описание либо начало цели; может быть пустым. */
  description: string;
  /** Прогресс этапов. */
  stages: { total: number; completed: number };
  /** Первый незавершённый этап. */
  nextStageTitle: string | null;
  /** Фактическое выполнение задач плана. */
  tasks: { total: number; completed: number; blocked: number; percent: number };
  /** Весь непустой состав фактически выполнен. */
  isReady: boolean;
};

/** Планы работ проекта. */
export type OverviewPlans = {
  /** Все планы. */
  total: number;
  /** Собственные статусы планов. */
  byStatus: Record<OverviewPlanStatus, number>;
  /** Завершённые по статусу, но фактически не выполненные планы. */
  completedNotReady: number;
  /** Активные планы. */
  active: OverviewPreview<OverviewPlan>;
};

/** Статус релиза. */
export type OverviewReleaseStatus = "planned" | "released" | "cancelled";

/** Релиз проекта. */
export type OverviewRelease = {
  /** Постоянный ID релиза. */
  id: string;
  /** Читаемый ключ релиза. */
  key: string;
  /** Название релиза. */
  title: string;
  /** Пользовательская версия выпуска. */
  version: string;
  /** Плановая дата YYYY-MM-DD либо null. */
  plannedFor: string | null;
  /** Время фактического выпуска либо null. */
  releasedAt: string | null;
  /** Фактическая готовность состава. */
  readiness: { total: number; ready: number; percent: number; canRelease: boolean };
};

/** Релизы проекта. */
export type OverviewReleases = {
  /** Все релизы. */
  total: number;
  /** Собственные статусы релизов. */
  byStatus: Record<OverviewReleaseStatus, number>;
  /** Запланированные релизы, ближайшие первыми. */
  upcoming: OverviewPreview<OverviewRelease>;
  /** Выпущенные релизы, последние первыми. */
  recent: OverviewPreview<OverviewRelease>;
};

/** Причина, по которой обязательства задачи сейчас не выполнены. */
export type OverviewObligationReason = "criterion" | "dependency" | "child";

/** Доска задачи метрики оператора. */
export type OverviewTaskBoard = {
  /** Адрес доски в проекте. */
  slug: string;
  /** Название доски. */
  name: string;
};

/** Задача метрики оператора с основанием включения. */
export type OverviewOperatorTask = OverviewTask & {
  /** Все причины невыполненных обязательств без повторов; пусто — обязательства выполнены. */
  reasons: OverviewObligationReason[];
};

/** Незавершённая задача, которую блокер задерживает напрямую. */
export type OverviewAffectedTask = OverviewTaskRef & {
  /** Текущая доска задачи. */
  board: OverviewTaskBoard;
  /** Прямая связь с блокером: зависимость, подзадача или обе сразу. */
  relations: ("dependency" | "subtask")[];
};

/** Прямой блокер незавершённой работы; может быть в любой колонке, включая «Отменено». */
export type OverviewBlockerImpact = OverviewTaskRef & {
  /** Текущая доска блокера. */
  board: OverviewTaskBoard;
  /** Прямо затронутые незавершённые задачи: полный счётчик и первые записи. */
  affected: {
    /** Число различных незавершённых задач, которые блокер задерживает напрямую. */
    total: number;
    /** Первые затронутые задачи, не более пяти. */
    items: OverviewAffectedTask[];
  };
};

/** Доска с распределением незавершённой работы; показатели пересекаются. */
export type OverviewBoardWork = Omit<OverviewBoard, "taskCount" | "openTaskCount"> & {
  /** Задачи доски по смыслу показателей. */
  tasks: {
    /** Все задачи доски, включая «Готово» и «Отменено». */
    total: number;
    /** Число задач в каждой из шести колонок. */
    byColumn: Record<OverviewTaskColumn, number>;
    /** Фактически выполненные задачи. */
    completed: number;
    /** Незавершённые: не отменены и фактически не выполнены. */
    remaining: number;
    /** Незавершённые задачи с прямыми блокерами; пересекается с remaining. */
    blockedRemaining: number;
    /** Можно брать в работу. */
    readyToStart: number;
  };
};

/** План метрики оператора: статус и фактическое выполнение состава. */
export type OverviewOperatorPlan = {
  /** Постоянный ID плана. */
  id: string;
  /** Читаемый ключ плана. */
  key: string;
  /** Название плана. */
  title: string;
  /** Собственный статус плана. */
  status: OverviewPlanStatus;
  /** Прогресс этапов. */
  stages: { total: number; completed: number };
  /** Фактическое выполнение задач состава. */
  tasks: { total: number; completed: number; percent: number };
};

/**
 * Показатели оператора из того же среза: полные счётчики и подборки до пяти записей.
 * Показатели пересекаются и не складываются; общего балла нет.
 */
export type OverviewOperator = {
  /** M-01. Задачи на проверке, разделённые по готовности обязательств. */
  review: {
    /** Все задачи на проверке; равно сумме двух групп. */
    total: number;
    /** Обязательства выполнены: завершение можно рассмотреть. */
    obligationsMet: OverviewPreview<OverviewOperatorTask>;
    /** Остались невыполненные критерии или прямые обязательства. */
    obligationsOpen: OverviewPreview<OverviewOperatorTask>;
  };
  /** M-02. Прямые блокеры незавершённой работы; больше затронутых задач первыми. */
  blockerImpact: OverviewPreview<OverviewBlockerImpact>;
  /** M-03. Задачи «В работе» и «На проверке» вне состава черновых и активных планов. */
  unplannedWork: OverviewPreview<OverviewOperatorTask> & {
    /** Разбиение по колонкам исполняемой работы. */
    byColumn: { inProgress: number; review: number };
  };
  /** M-04. Распределение незавершённой работы по доскам. */
  boardWork: {
    /** Все незавершённые задачи проекта. */
    remaining: number;
    /** Незавершённые задачи проекта с прямыми блокерами. */
    blockedRemaining: number;
    /** Доски: больше незавершённых задач первыми, включая пустые. */
    boards: OverviewPreview<OverviewBoardWork>;
  };
  /** M-05. Черновые и активные планы с выполненным непустым составом. */
  openPlansComplete: OverviewPreview<OverviewOperatorPlan>;
  /** M-06. Подготовка выпуска. */
  releasePreparation: {
    /** Запланированные релизы с готовым составом. */
    readyReleases: OverviewPreview<OverviewRelease>;
    /** Завершённые готовые планы вне запланированных и выпущенных релизов. */
    completedPlansOutsideReleases: OverviewPreview<OverviewOperatorPlan>;
  };
};

/** Полный список метрики оператора, раскрываемый постранично. */
export type OverviewMetric =
  | "review-obligations-met"
  | "review-obligations-open"
  | "blocker-impact"
  | "blocker-affected"
  | "unplanned-work"
  | "board-work"
  | "open-plans-complete"
  | "ready-releases"
  | "plans-outside-releases";

/** Что раскрыть: метрика и для затронутых задач — постоянный ID блокера. */
export type OverviewMetricRequest =
  | { metric: Exclude<OverviewMetric, "blocker-affected"> }
  | { metric: "blocker-affected"; blocker: string };

/** Запись полного списка метрики; вид записи определяет её отображение. */
export type OverviewMetricEntry =
  | { kind: "task"; id: string; task: OverviewOperatorTask }
  | { kind: "affected"; id: string; task: OverviewAffectedTask }
  | { kind: "blocker"; id: string; blocker: OverviewBlockerImpact }
  | { kind: "board"; id: string; board: OverviewBoardWork }
  | { kind: "plan"; id: string; plan: OverviewOperatorPlan }
  | { kind: "release"; id: string; release: OverviewRelease };

/** Страница полного списка метрики, построенная на одном неизменном срезе. */
export type OverviewMetricPage = {
  /** Версия среза, на котором построена страница. */
  snapshotVersion: string;
  /** Полное число записей метрики независимо от страницы. */
  total: number;
  /** Записи страницы в порядке метрики. */
  entries: OverviewMetricEntry[];
  /** Продолжение того же среза либо null в конце. */
  nextCursor: string | null;
};

/** Согласованный срез состояния проекта из одного чтения сервера. */
export type ProductOverview = {
  /** Отпечаток данных среза; меняется при любом изменении показанных данных. */
  snapshotVersion: string;
  /** Время формирования ответа сервером. */
  generatedAt: string;
  /** Выбранный проект. */
  project: { name: string; slug: string };
  /** Паспорт продукта. */
  passport: OverviewPassport;
  /** Продуктовые знания. */
  knowledge: OverviewKnowledge;
  /** Доски проекта. */
  boards: {
    /** Все доски, включая пустые. */
    total: number;
    /** Разбиение по области. */
    byKind: Record<OverviewBoard["kind"], number>;
    /** Доски в порядке каталога. */
    catalog: OverviewPreview<OverviewBoard>;
  };
  /** Статистика задач. */
  tasks: OverviewTasks;
  /** Задачи, требующие внимания. */
  attention: {
    /** Задачи в работе. */
    inProgress: OverviewPreview<OverviewTask>;
    /** Задачи на проверке. */
    review: OverviewPreview<OverviewTask>;
    /** Заблокированные задачи. */
    blocked: OverviewPreview<OverviewTask>;
  };
  /** Библиотека документов. */
  documents: OverviewDocuments;
  /** Планы работ. */
  plans: OverviewPlans;
  /** Релизы. */
  releases: OverviewReleases;
  /** Показатели оператора. */
  operator: OverviewOperator;
};

/**
 * Актуальность показанного обзора относительно потока изменений проекта.
 *
 * - `live` — поток подключён, последнее изменение прочитано;
 * - `refreshing` — получено изменение, повторное чтение ещё выполняется;
 * - `connecting` — поток изменений подключается или восстанавливается;
 * - `offline` — поток недоступен дольше короткого переподключения, данные могут устареть;
 * - `stale` — последнее повторное чтение не удалось, показаны прежние данные;
 * - `storage-error` — сервер сообщил об ошибке хранилища проекта.
 */
export type ProductOverviewFreshness =
  "live" | "refreshing" | "connecting" | "offline" | "stale" | "storage-error";

/** Состояние актуальности вместе с причиной ошибки хранилища. */
export type ProductOverviewSync = {
  /** Актуальность показанных данных. */
  freshness: ProductOverviewFreshness;
  /** Сообщение сервера об ошибке хранилища. */
  message?: string;
};
