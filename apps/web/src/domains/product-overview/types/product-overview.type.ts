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
