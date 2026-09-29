import type { ComponentPropsWithoutRef } from "react";
import type { OverviewPassport, ProductOverviewFreshness } from "domains/product-overview";

/** Параметры заголовка обзора. */
export type OverviewHeaderParams = {
  /** Отображаемое имя и адрес проекта. */
  project: { name: string; slug: string };
  /** Паспорт продукта. */
  passport: OverviewPassport;
  /** Время формирования показанного среза. */
  generatedAt: string;
  /** Актуальность показанных данных. */
  freshness: ProductOverviewFreshness;
  /** Адрес паспорта продукта. */
  passportPath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"header">, "children">;
/** Свойства заголовка обзора. */
export type OverviewHeaderProps = RootAttrs & OverviewHeaderParams;
