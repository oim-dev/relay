import type { ComponentPropsWithoutRef, Ref } from "react";
import type { DocumentEntity } from "domains/documents";

/** Параметры варианта выборщика. */
export type PickerOptionParams = {
  /** Краткая карточка материала. */
  material: DocumentEntity;
  /** Подпись раздела. */
  sectionName: string;
  /** Подписи уже существующих связей с сущностью. */
  attachedLabels: string[];
  /** Материал выбран. */
  isSelected: boolean;
  /** Выбор недоступен: связь выбранного типа уже есть. */
  isLocked: boolean;
  /** Выбор недоступен на время записи. */
  isDisabled: boolean;
  /** Меняет выбор. */
  onToggle: (checked: boolean) => void;
  /** Открывает предпросмотр. */
  onPreview: () => void;
  /** Ссылка на кнопку предпросмотра для возврата фокуса. */
  previewRef?: Ref<HTMLButtonElement>;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children" | "onToggle">;
/** Свойства варианта выборщика. */
export type PickerOptionProps = RootAttrs & PickerOptionParams;
