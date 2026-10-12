import type { ComponentPropsWithoutRef } from "react";
import type { BoardTask } from "domains/board-tasks";

/** Параметры визуальной области. */
export type TaskAcceptanceParams = {
  /** Текущий проект. */
  projectId: string;
  /** Подтверждённое состояние задачи. */
  task: BoardTask;
  /** Собственная запись обновляет ревизию основного редактора. */
  onOwnRevision: (revision: number) => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children" | "title">;
/** Свойства визуальной области. */
export type TaskAcceptanceProps = RootAttrs & TaskAcceptanceParams;
