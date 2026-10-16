import type { ComponentPropsWithoutRef } from "react";
import type { DocumentRelation } from "domains/documents";

/** Параметры блока «Материалы» сущности. */
export type EntityDocumentsParams = {
  /** Постоянный адрес сущности любого из 11 видов: kind и ID (для продукта — `passport`). */
  target: DocumentRelation["target"];
  /** Название сущности для выборщика и подписи прикрепления; без него используется вид. */
  targetTitle?: string;
  /**
   * Сообщает родительскому диалогу, что блок открыл собственное окно (выборщик или предпросмотр),
   * чтобы родитель временно снял свою ловушку фокуса и закрытие по Escape.
   */
  onOpenedChange?: (opened: boolean) => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children">;
/** Свойства блока «Материалы». */
export type EntityDocumentsProps = RootAttrs & EntityDocumentsParams;
