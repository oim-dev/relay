import type { DocumentEntity, DocumentRelation } from "domains/documents";

/** Материал, связи которого показываются и меняются по одной под его ревизией. */
export type RelationsMaterial = {
  /** Постоянный ID материала. */
  id: string;
  /** Прочитанная ревизия, под которой выполняется изменение связи. */
  revision: number;
  /** Адресные связи relations. */
  relations: DocumentRelation[];
  /** Совместимые области links: читаются как связи «Описывает сущность» без пояснения. */
  legacyLinks: DocumentRelation[];
  /** Уже прочитанные карточки целей. */
  references: DocumentEntity[];
};
/** Блок «Где используется» карточки материала. */
export type DocumentRelationsProps = {
  /** Подтверждённый материал. */
  material: RelationsMaterial;
};
