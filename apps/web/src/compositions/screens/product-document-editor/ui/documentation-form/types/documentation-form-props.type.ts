import type { ComponentPropsWithoutRef } from "react";
import type { DocumentInput } from "domains/documents";

/** Сущность, к которой новый материал прикрепляется при создании. */
export type EditorAttachment = {
  /** Название сущности. */
  title: string;
  /** Публичный ключ. */
  entityKey: string;
  /** Вид сущности по-русски. */
  kindLabel: string;
};
/** Параметры формы материала. */
export type DocumentationFormParams = {
  /** Заголовок экрана редактора. */
  title: string;
  /** Исходное содержимое материала. */
  initial: DocumentInput;
  /** ID сохранённого материала; отсутствует при создании. */
  documentId?: string | undefined;
  /** Прочитанная ревизия материала. */
  revision: number;
  /** Изолированная область локальной восстановительной копии. */
  draftScope: string;
  /** Начальное прикрепление нового материала; null — без прикрепления. */
  attachment: EditorAttachment | null;
  /** Переход после явной отмены. */
  cancelTo: string;
  /** Возврат после создания (например, к сущности); null — открыть карточку материала. */
  createdReturnTo: string | null;
  /** Каталог с условиями, куда карточка вернёт человека. */
  catalogReturn: string;
  /** Перечитывает материал после отказа записи. */
  onReload: () => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"form">, "children" | "onSubmit" | "title">;
/** Свойства формы материала. */
export type DocumentationFormProps = RootAttrs & DocumentationFormParams;
