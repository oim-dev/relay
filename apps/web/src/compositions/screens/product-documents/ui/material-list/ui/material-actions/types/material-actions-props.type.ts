import type { DocumentSection, MaterialPropertyChanges } from "domains/documents";

/** Быстрые действия одного материала каталога. */
export type MaterialActionsProps = {
  /** Название материала для доступных подписей. */
  title: string;
  /** Текущее закрепление. */
  isPinned: boolean;
  /** Материал в архиве. */
  isArchived: boolean;
  /** Текущий раздел или null. */
  sectionId: string | null;
  /** Разделы библиотеки для перемещения. */
  sections: DocumentSection[];
  /** Идёт запись этого материала. */
  isBusy: boolean;
  /** Запрос изменения свойств под прочитанной ревизией. */
  onChange: (changes: MaterialPropertyChanges) => void;
};
