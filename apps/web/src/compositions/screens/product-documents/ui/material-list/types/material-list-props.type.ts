import type { ComponentPropsWithoutRef, ReactNode } from "react";
import type {
  DocumentEntity,
  DocumentSection,
  MaterialPropertyChanges,
  MaterialSort,
} from "domains/documents";

/** Материал каталога с обязательными свойствами документа. */
export type CatalogMaterial = DocumentEntity & {
  document: NonNullable<DocumentEntity["document"]>;
};
/** Параметры выдачи каталога. */
export type MaterialListParams = {
  /** Название выбранной области. */
  title: string;
  /** Полное число материалов области по данным сервера. */
  total: number | null;
  /** Показанные материалы всех прочитанных порций. */
  items: CatalogMaterial[];
  /** Разделы библиотеки. */
  sections: DocumentSection[];
  /** Строка поиска для подсветки совпадений. */
  query: string;
  /** Порядок выдачи. */
  sort: MaterialSort;
  /** Порядок задан представлением и не меняется. */
  isSortFixed: boolean;
  /** Адрес полной карточки материала. */
  getHref: (id: string) => string;
  /** Адрес каталога для возврата из карточки. */
  returnTo: string;
  /** ID материалов, для которых идёт запись. */
  busyIds: ReadonlySet<string>;
  /** ID материалов в множественном выборе. */
  selectedIds: ReadonlySet<string>;
  /** Есть следующая порция. */
  hasMore: boolean;
  /** Следующая порция читается. */
  isLoadingMore: boolean;
  /** Состояние выдачи при отсутствии строк: загрузка или пустая выдача. */
  state?: ReactNode;
  /** Изменение порядка выдачи. */
  onSortChange: (sort: MaterialSort) => void;
  /** Чтение следующей порции. */
  onLoadMore: () => void;
  /** Переход к полной карточке. */
  onOpen: (id: string) => void;
  /** Быстрый предпросмотр. */
  onPreview: (material: CatalogMaterial) => void;
  /** Включение материалов в выбор или исключение из него. */
  onSelect: (materials: CatalogMaterial[], isSelected: boolean) => void;
  /** Изменение свойств материала. */
  onChange: (material: CatalogMaterial, changes: MaterialPropertyChanges) => void;
};
/** Атрибуты области выдачи. */
type RootAttrs = Omit<
  ComponentPropsWithoutRef<"section">,
  "children" | "title" | "onChange" | "onSelect"
>;
/** Свойства выдачи каталога. */
export type MaterialListProps = RootAttrs & MaterialListParams;
