import type { ComponentPropsWithoutRef } from "react";
import type { DocumentRelation } from "domains/documents";

/** Значения формы связи. */
export type RelationFormValues = {
  /** Тип связи. */
  type: DocumentRelation["type"];
  /** Markdown-пояснение: зачем читать материал для этой сущности. */
  description: string;
};
/** Параметры формы изменения связи. */
export type RelationFormParams = {
  /** Текущий тип связи. */
  type: DocumentRelation["type"];
  /** Текущее пояснение. */
  description: string;
  /** Типы, которые у материала с этой сущностью уже есть в других связях. */
  takenTypes: DocumentRelation["type"][];
  /** Запись выполняется. */
  isSubmitting: boolean;
  /** Сохраняет изменения. */
  onSubmit: (values: RelationFormValues) => Promise<void>;
  /** Закрывает форму без записи. */
  onCancel: () => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"form">, "children" | "onSubmit">;
/** Свойства формы изменения связи. */
export type RelationFormProps = RootAttrs & RelationFormParams;
