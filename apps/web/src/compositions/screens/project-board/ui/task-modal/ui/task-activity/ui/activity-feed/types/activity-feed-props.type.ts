import type { ComponentPropsWithoutRef } from "react";
import type { ActivitySummary } from "domains/board-tasks";

/** Параметры визуальной области. */
export type ActivityFeedParams = {
  /** Выбранный проект. */
  projectId: string;
  /** Постоянный ID задачи. */
  taskId: string;
  /** Загруженные записи в порядке от новых к старым. */
  entries: ActivitySummary[];
  /** Открыт ли таб. */
  active: boolean;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства визуальной области. */
export type ActivityFeedProps = RootAttrs & ActivityFeedParams;
