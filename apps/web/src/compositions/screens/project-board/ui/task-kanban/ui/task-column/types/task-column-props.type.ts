import type { TaskColumn, TaskFilters, TaskSummary, TasksPage } from "domains/board-tasks";
import type { ProductTargetPreview } from "domains/product";

/** Независимая колонка с продолжением и возможностью принять карточку. */
export type TaskColumnProps = {
  /** Текущий изолированный проект. */
  projectId: string;
  /** Колонка и её представление в шапке. */
  column: { value: TaskColumn; label: string };
  /** Фильтры списка задач. */
  filters: TaskFilters;
  /** Адрес места вставки. */
  targetId: string | null;
  /** Выполняется сохранение переноса. */
  isSaving: boolean;
  /** Локальная проекция списка на время жеста и записи. */
  preview: TaskSummary[] | undefined;
  /** Общее число задач с учётом локального переноса. */
  previewTotal: number | undefined;
  /** ID поднятой карточки. */
  activeId: string | null;
  /** Размер поднятой карточки для места вставки. */
  activeSize: { width: number; height: number } | undefined;
  /** Сохраняет страницу и названия целей перед началом переноса. */
  onSnapshot: (
    column: TaskColumn,
    page: TasksPage,
    nextId: string | null,
    targets: Map<string, ProductTargetPreview> | undefined,
    targetState: "loading" | "ready" | "error",
  ) => void;
  /** Сообщает доске, есть ли у колонки ошибка чтения: доска объявляет её один раз. */
  onReadErrorChange: (column: TaskColumn, hasError: boolean) => void;
  /** Открывает существующую задачу. */
  onOpen: (id: string) => void;
  /** Создаёт задачу в выбранной колонке. */
  onCreate: (column: TaskColumn) => void;
};
