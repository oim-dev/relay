import type { ComponentPropsWithoutRef } from "react";

/** Параметры визуальной области. */
export type TaskActivityParams = {
  /** Проект, которому принадлежит задача. */
  projectId: string;
  /** Постоянный ID задачи. */
  taskId: string;
  /** Загружать данные только открытого таба. */
  active: boolean;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства визуальной области. */
export type TaskActivityProps = RootAttrs & TaskActivityParams;
