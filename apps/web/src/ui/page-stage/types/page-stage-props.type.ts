import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Параметры сцены экрана. */
export type PageStageParams = {
  /** Содержимое сцены. */
  children?: ReactNode;
};
/** Атрибуты сцены; внешняя серая область не настраивается. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства сцены экрана. */
export type PageStageProps = RootAttrs & PageStageParams;
