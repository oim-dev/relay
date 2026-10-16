import type { ComponentPropsWithoutRef } from "react";
import type { BoardTask } from "domains/board-tasks";
import type { Board } from "domains/boards";

/** Параметры визуальной области. */
export type TaskContextParams = {
  /** Содержимое области. */
  projectId: string;
  /** Задача с подтверждёнными продуктовыми связями. */
  task: BoardTask;
  /** Подтверждённая доска задачи определяет доступные цели реализации. */
  board: Board;
  /** Собственная запись не должна создавать конфликт черновика описания. */
  onOwnRevision: (revision: number) => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children" | "title">;
/** Свойства визуальной области. */
export type TaskContextProps = RootAttrs & TaskContextParams;
