import type { ComponentPropsWithoutRef } from "react";
import type { OverviewDocuments } from "domains/product-overview";

/** Параметры сводки библиотеки документов. */
export type PinnedDocumentsParams = {
  /** Библиотека документов проекта. */
  documents: OverviewDocuments;
  /** Базовый адрес проекта. */
  basePath: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства сводки библиотеки документов. */
export type PinnedDocumentsProps = RootAttrs & PinnedDocumentsParams;
