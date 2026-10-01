import type { ComponentPropsWithoutRef } from "react";

/** Параметры краткого описания продукта. */
export type PassportSummaryParams = {
  /** Текст summary либо начала описания паспорта. */
  text: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства краткого описания продукта. */
export type PassportSummaryProps = RootAttrs & PassportSummaryParams;
