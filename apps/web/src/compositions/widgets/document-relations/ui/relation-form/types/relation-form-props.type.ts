import type { ComponentPropsWithoutRef } from "react";
import type { DocumentRelation } from "domains/documents";
import type { RelationEntry } from "../../../types/relation-entry.type";

/** Ввод связи: адрес сущности `kind:id`, тип и пояснение. */
export type RelationFormValues = {
  /** Адрес выбранной сущности; null — ещё не выбрана. */
  target: string | null;
  /** Смысл связи. */
  type: DocumentRelation["type"];
  /** Зачем нужен материал для этой сущности (Markdown). */
  description: string;
};
/** Параметры формы связи. */
export type RelationFormParams = {
  /** Изменяемая связь; отсутствует при прикреплении к новой сущности. */
  entry?: RelationEntry | undefined;
  /** Собственный проект для выбора сущности. */
  projectId: string;
  /** Записывает связь; ожидаемые отказы выбрасываются как DocumentAccessError. */
  onSubmit: (values: RelationFormValues) => Promise<void>;
  /** Закрывает форму без записи. */
  onCancel: () => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"form">, "children" | "onSubmit">;
/** Свойства формы связи. */
export type RelationFormProps = RootAttrs & RelationFormParams;
