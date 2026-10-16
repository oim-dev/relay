import type { ComponentPropsWithoutRef } from "react";
import type { DocumentRelation, EntityMaterial } from "domains/documents";

/** Параметры строки материала сущности. */
export type MaterialEntryParams = {
  /** Материал с его прямыми связями с этой сущностью. */
  material: EntityMaterial;
  /** Сущность, со стороны которой меняются связи. */
  target: DocumentRelation["target"];
  /** Адрес карточки материала. */
  href: string;
  /** Внутренний адрес возврата из карточки. */
  returnTo: string;
  /** Открывает предпросмотр материала. */
  onPreview: () => void;
  /** Сообщает итог записи; shouldFocusHeading — строка может исчезнуть, фокус уходит к заголовку. */
  onDone: (message: string, shouldFocusHeading: boolean) => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"article">, "children">;
/** Свойства строки материала. */
export type MaterialEntryProps = RootAttrs & MaterialEntryParams;
