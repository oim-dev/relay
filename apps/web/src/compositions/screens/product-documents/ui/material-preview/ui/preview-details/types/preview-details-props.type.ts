import type { KnowledgeDocument } from "domains/documents";

/** Прочитанный материал в панели предпросмотра. */
export type PreviewDetailsProps = {
  /** Подтверждённое содержание, свойства и прямые прикрепления. */
  document: KnowledgeDocument;
  /** Название раздела материала. */
  sectionName: string;
};
