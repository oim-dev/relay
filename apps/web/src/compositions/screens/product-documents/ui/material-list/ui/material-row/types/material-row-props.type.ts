import type { DocumentEntity, DocumentSection, MaterialPropertyChanges } from "domains/documents";

/** Компактная строка материала в каталоге. */
export type MaterialRowProps = {
  /** Серверная карточка материала со свойствами документа. */
  material: DocumentEntity & { document: NonNullable<DocumentEntity["document"]> };
  /** Название раздела материала. */
  sectionName: string;
  /** Постоянный адрес полной карточки. */
  href: string;
  /** Адрес каталога для возврата из карточки. */
  returnTo: string;
  /** Строка поиска для подсветки совпадений; пустая — без подсветки. */
  query: string;
  /** Разделы библиотеки для быстрого перемещения. */
  sections: DocumentSection[];
  /** Идёт запись этого материала. */
  isBusy: boolean;
  /** Материал входит в множественный выбор. */
  isSelected: boolean;
  /** Переход к полной карточке. */
  onOpen: () => void;
  /** Открытие быстрого предпросмотра. */
  onPreview: () => void;
  /** Включение в множественный выбор или исключение из него. */
  onSelectChange: (isSelected: boolean) => void;
  /** Изменение свойств под прочитанной ревизией. */
  onChange: (changes: MaterialPropertyChanges) => void;
};
