import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Параметры смысловой области обзора. */
export type OverviewPanelParams = {
  /** Заголовок области. */
  title: string;
  /** Полное число записей области, если оно имеет смысл. */
  total?: number;
  /** Переход к полному разделу. */
  link?: {
    /** Адрес раздела. */
    to: string;
    /** Подпись перехода. */
    label: string;
  };
  /** Ограниченная подборка: показанное и полное число записей. */
  preview?: {
    /** Показанные записи. */
    shown: number;
    /** Все записи проекта. */
    total: number;
  };
  /** Уровень области: срочная работа или справочный контекст проекта. */
  tone?: "primary" | "quiet";
  /** Содержимое области. */
  children: ReactNode;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children" | "title">;
/** Свойства смысловой области обзора. */
export type OverviewPanelProps = RootAttrs & OverviewPanelParams;
