import type { ComponentPropsWithoutRef } from "react";

/** Отбор работы по контексту. */
export type ProductWorkListParams = {
  /** Выбранная фича. */
  featureId?: string;
  /** Выбранное приложение. */
  applicationId?: string;
};
/** Атрибуты области работы. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children" | "title">;
/** Свойства истории реализации. */
export type ProductWorkListProps = RootAttrs & ProductWorkListParams;
