/** Состояние плана работ. */
export type PlanStatus = "draft" | "active" | "completed" | "cancelled";
/** Полные серверные показатели собственного состава. */
export type PlanSummary = {
  /** Всего задач. */
  total: number;
  /** Фактически выполнено. */
  done: number;
  /** В работе. */
  active: number;
  /** На проверке. */
  review: number;
  /** Есть обязательства. */
  blocked: number;
  /** Полный процент. */
  percent: number;
};
/** План для чтения и редактирования Web. */
export type PlanningPlan = {
  /** Постоянный ID; new только у несохранённого ввода. */
  id: string;
  /** Читаемый ключ. */
  key: string;
  /** Исходная ревизия редактирования. */
  revision: number;
  /** Название. */
  title: string;
  /** Краткий обычный текст. */
  summary: string;
  /** Цель Markdown. */
  goal: string;
  /** Обоснование Markdown. */
  rationale: string;
  /** Границы Markdown. */
  boundaries: string;
  /** Ожидаемый результат Markdown. */
  expectedResult: string;
  /** Участники. */
  participants: string[];
  /** Историческое состояние плана. */
  status: PlanStatus;
  /** Адреса области kind:ID. */
  scope: string[];
  /** Человеческие подписи области. */
  scopeLabels: string[];
  /** Дата изменения. */
  updatedAt: string;
  /** Итог Markdown. */
  result: string;
  /** Полное число этапов. */
  stageCount: number;
  /** Краткие индикаторы этапов. */
  stagePreview: { id: string; completed: boolean }[];
  /** Название ближайшего этапа. */
  nextStageTitle: string | null;
  /** Полные показатели. */
  progress: PlanSummary;
  /** Текущая готовность всего состава. */
  isReady: boolean;
};
/** Этап с отдельным постраничным чтением задач. */
export type PlanStage = {
  /** Внутренний ID записи этапа в плане. */
  id: string;
  /** Название. */
  title: string;
  /** Краткий текст. */
  summary: string;
  /** Результат Markdown. */
  outcome: string;
  /** Условия Markdown. */
  completionConditions: string;
  /** Полные ID для сохранения скрытого выбора; карточки читаются страницами. */
  taskIds: string[];
  /** Полные показатели этапа. */
  progress: PlanSummary;
};
/** Строка актуальной задачи; полное описание читается отдельно. */
export type PlanningTask = {
  /** Постоянный ID. */
  id: string;
  /** Ключ. */
  key: string;
  /** Название. */
  title: string;
  /** Доска. */
  board: string;
  /** Сохранённая колонка. */
  status: "inbox" | "ready" | "in-progress" | "review" | "done" | "cancelled";
  /** Фактическое выполнение. */
  isCompleted: boolean;
  /** Объяснение обязательств. */
  blocker?: string;
  /** Текущее включение. */
  assignment: { planId: string; stageId: string; label: string } | null;
};
/** Страница предметных записей. */
export type PlanningPage<Item> = {
  /** Загруженные записи. */
  items: Item[];
  /** Полное количество. */
  total: number;
  /** Продолжение. */
  nextOffset: number | null;
  /** Версия снимка. */
  version: string;
};
/** Поиск планов. */
export type PlanFilters = {
  /** Текст поиска. */
  q?: string;
  /** Статус либо отсутствие фильтра. */
  status?: PlanStatus;
};
/** Поиск задач для этапа. */
export type PlanningTaskFilters = {
  /** План редактируемого этапа. */
  plan?: string;
  /** Текст поиска. */
  q?: string;
  /** Доска. */
  board?: string;
  /** Редактируемый этап. */
  stage?: string;
  /** Только доступные. */
  isAvailableOnly: boolean;
};
