import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";

/**
 * Оформление панели: обычная тонированная, главная с градиентом на всю панель
 * или главная каталожная, у которой градиент ограничен шапкой.
 */
export type SectionPanelTone = "default" | "feature" | "feature-header";

/** Параметры смысловой панели экрана. */
export type SectionPanelParams = {
  /** Заголовок панели. */
  title: ReactNode;
  /** Уровень заголовка по структуре экрана. */
  titleAs?: "h2" | "h3";
  /**
   * Ссылка на заголовок, если владелец переводит на него фокус (например, когда исчезла
   * строка с фокусом): заголовок становится программно фокусируемым.
   */
  titleRef?: Ref<HTMLHeadingElement>;
  /**
   * Полное число записей панели, если оно имеет смысл; ноль тоже показывается.
   * Может включать скрытое для зрения пояснение числа.
   */
  count?: ReactNode;
  /**
   * Что считает число, если рядом есть другие числа: показывается «подпись: число».
   */
  countLabel?: string;
  /** Действия шапки: переход к разделу, сортировка; выравниваются к концу строки. */
  actions?: ReactNode;
  /** Пояснение: что показывает или считает панель. */
  description?: ReactNode;
  /** Оформление панели. */
  tone?: SectionPanelTone;
  /** Плотность: compact — для выдачи строк, которым нужна почти вся ширина. */
  density?: "default" | "compact";
  /** Содержимое панели. */
  children?: ReactNode;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children" | "title">;
/** Свойства смысловой панели экрана. */
export type SectionPanelProps = RootAttrs & SectionPanelParams;
