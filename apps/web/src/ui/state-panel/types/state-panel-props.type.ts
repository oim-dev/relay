import type { ComponentPropsWithoutRef, ReactNode } from "react";

/**
 * Вид состояния: первичная загрузка, пустота (в том числе отсутствие совпадений
 * или записи) либо ошибка чтения с восстановлением.
 */
export type StatePanelState = "loading" | "empty" | "error";

/** Содержимое состояния страницы или панели. */
export type StatePanelParams = {
  /** Короткий заголовок. */
  title: string;
  /**
   * Уровень заголовка: h1 для самостоятельной страницы, h2 для вложенной панели.
   */
  titleAs?: "h1" | "h2";
  /** Причина состояния и следующий шаг. */
  description: string;
  /** Доступное действие: повтор, сброс фильтров, переход. */
  action?: ReactNode;
  /**
   * Вид состояния. Ошибка объявляется как alert и отличается значком и тоном,
   * загрузка — как занятая область. По умолчанию — пустота.
   */
  state?: StatePanelState;
};
/** Атрибуты контейнера. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "title" | "children">;
/** Свойства представления состояния. */
export type StatePanelProps = RootAttrs & StatePanelParams;
