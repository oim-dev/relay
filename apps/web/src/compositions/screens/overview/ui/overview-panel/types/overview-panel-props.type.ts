import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Параметры смысловой области обзора. */
export type OverviewPanelParams = {
  /** Заголовок области. */
  title: string;
  /** Полное число записей области, если оно имеет смысл. */
  total?: number;
  /**
   * Что считает полное число, если рядом есть другие числа и голое число читается
   * неоднозначно: бейдж показывает «подпись: число».
   */
  totalLabel?: string;
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
  /** Пояснение: что именно считает или показывает область. */
  description?: string;
  /** Оформление: обычная карточка или главная карточка экрана с градиентом. */
  tone?: "default" | "feature";
  /** Содержимое области. */
  children: ReactNode;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children" | "title">;
/** Свойства смысловой области обзора. */
export type OverviewPanelProps = RootAttrs & OverviewPanelParams;
