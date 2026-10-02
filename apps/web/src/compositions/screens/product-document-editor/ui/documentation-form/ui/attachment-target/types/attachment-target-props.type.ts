import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Параметры начального прикрепления нового материала. */
export type AttachmentTargetParams = {
  /** Название сущности. */
  title: string;
  /** Публичный ключ сущности. */
  entityKey: string;
  /** Вид сущности по-русски. */
  kindLabel: string;
  /** Поля смысла и пояснения связи. */
  children?: ReactNode;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children" | "title">;
/** Свойства начального прикрепления. */
export type AttachmentTargetProps = RootAttrs & AttachmentTargetParams;
