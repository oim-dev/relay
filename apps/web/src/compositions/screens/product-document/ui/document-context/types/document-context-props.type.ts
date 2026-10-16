import type { KnowledgeDocument } from "domains/documents";

/** Свойства и оглавление читаемого материала. */
export type DocumentContextProps = {
  /** Подтверждённый материал. */
  document: KnowledgeDocument;
  /** Название его раздела. */
  sectionName: string;
  /** Заголовки отрисованного Markdown; для ссылки пусто. */
  outline: { id: string; title: string; level: number }[];
};
