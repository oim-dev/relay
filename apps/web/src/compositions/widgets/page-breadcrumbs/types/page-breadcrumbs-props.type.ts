import type { ComponentPropsWithoutRef } from "react";
import type { EntityKind } from "domains/entities";

/** Адресный источник названия, не требующий загрузки каталога. */
export type BreadcrumbSource = {
  /** Проект, которому принадлежит запись. */
  projectId: string;
  /** Вид записи; доски читаются по slug. */
  kind: EntityKind;
  /** Ключ, ID или slug доски. */
  reference: string;
};
/** Один уровень навигации; последний элемент всегда является текущей страницей. */
export type PageBreadcrumb = {
  /** Устойчивая идентичность уровня. */
  id: string;
  /** Название либо резервная подпись до загрузки. */
  label: string;
  /** Адрес доступного родителя. */
  href?: string;
  /** Источник актуального названия записи. */
  source?: BreadcrumbSource;
};
/** Параметры навигационной цепочки. */
type PageBreadcrumbsParams = {
  /** Уровни от корня к текущей странице. */
  items: readonly PageBreadcrumb[];
  /** Компактное размещение внутри модального окна. */
  embedded?: boolean;
};
/**
 * Атрибуты корневого элемента. `aria-label` по умолчанию «Хлебные крошки»; отдельная
 * подпись нужна, только если на странице несколько цепочек (примеры галереи).
 */
type RootAttrs = Omit<ComponentPropsWithoutRef<"nav">, "children">;
/** Свойства общей навигации глубины. */
export type PageBreadcrumbsProps = RootAttrs & PageBreadcrumbsParams;
