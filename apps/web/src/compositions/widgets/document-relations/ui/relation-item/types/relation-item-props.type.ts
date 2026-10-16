import type { ComponentPropsWithoutRef } from "react";
import type { RelationEntry } from "../../../types/relation-entry.type";

/** Параметры строки связи. */
export type RelationItemParams = {
  /** Показываемая связь. */
  entry: RelationEntry;
  /** Состояние маршрута, по которому сущность вернёт к материалу. */
  returnTo: string;
  /** Открывает изменение типа и пояснения. */
  onEdit: () => void;
  /** Открывает подтверждение снятия связи. */
  onDetach: () => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"li">, "children">;
/** Свойства строки связи. */
export type RelationItemProps = RootAttrs & RelationItemParams;
