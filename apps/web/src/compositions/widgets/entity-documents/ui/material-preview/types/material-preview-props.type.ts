import type { ComponentPropsWithoutRef } from "react";

/** Параметры предпросмотра материала. */
export type MaterialPreviewParams = {
  /** Постоянный ID материала. */
  materialId: string;
  /** Внутренний адрес возврата из полной карточки. */
  returnTo: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства предпросмотра материала. */
export type MaterialPreviewProps = RootAttrs & MaterialPreviewParams;
