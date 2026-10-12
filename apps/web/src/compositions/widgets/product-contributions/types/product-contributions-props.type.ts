import type { ComponentPropsWithoutRef } from "react";

/** Продуктовое требование, для которого приложения объявляют вклад. */
export type ProductContributionsParams = {
  /** Постоянный идентификатор фичи или сценария. */
  targetId: string;
};
/** Атрибуты области реализации. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children" | "title">;
/** Свойства списка вкладов. */
export type ProductContributionsProps = RootAttrs & ProductContributionsParams;
