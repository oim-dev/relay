import type { DocumentRelation } from "domains/documents";

/** Одна прямая связь материала, подготовленная к показу. */
export type RelationEntry = {
  /** Устойчивый адрес связи: вид, ID цели и тип. */
  address: string;
  /** Связь в форме контракта. */
  relation: DocumentRelation;
  /** Связь пришла из совместимой области links, а не из адресных relations. */
  isLegacy: boolean;
  /** Название сущности или пояснение о её недоступности. */
  title: string;
  /** Публичный ключ сущности. */
  entityKey: string;
  /** Переход к сущности; null, если сущность не прочитана. */
  href: string | null;
};
