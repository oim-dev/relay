import { entityDefinitions } from "@relay/contracts/entities";
import type { DocumentInput, MaterialFormat, MaterialTargetKind } from "../types/document.type";

/** Названия типов, одинаковые при чтении, создании и поиске. */
export const DOCUMENT_KINDS = {
  description: "Описание",
  specification: "Техническое задание",
  rules: "Правила",
  instruction: "Инструкция",
  proposal: "Проект решения",
  decision: "Решение",
  research: "Исследование",
};
/** Варианты назначения документа. */
export const DOCUMENT_KIND_OPTIONS: { value: DocumentInput["documentKind"]; label: string }[] = [
  { value: "description", label: DOCUMENT_KINDS.description },
  { value: "specification", label: DOCUMENT_KINDS.specification },
  { value: "rules", label: DOCUMENT_KINDS.rules },
  { value: "instruction", label: DOCUMENT_KINDS.instruction },
  { value: "proposal", label: DOCUMENT_KINDS.proposal },
  { value: "decision", label: DOCUMENT_KINDS.decision },
  { value: "research", label: DOCUMENT_KINDS.research },
];
/** Состояние документа, не состояние локального ввода. */
export const DOCUMENT_STATUSES = { draft: "Черновик", active: "Действующий", archived: "Архив" };
/** Варианты состояния публикации. */
export const DOCUMENT_STATUS_OPTIONS = Object.entries(DOCUMENT_STATUSES).map(([value, label]) => ({
  value,
  label,
}));
/** Назначение прикрепления документа к записи. */
export const DOCUMENT_RELATION_TYPES: Record<DocumentInput["relations"][number]["type"], string> = {
  references: "Для чтения",
  documents: "Описывает сущность",
};
/** Варианты назначения прикрепления. */
export const DOCUMENT_RELATION_TYPE_OPTIONS: {
  value: DocumentInput["relations"][number]["type"];
  label: string;
}[] = [
  { value: "references", label: DOCUMENT_RELATION_TYPES.references },
  { value: "documents", label: DOCUMENT_RELATION_TYPES.documents },
];
/** Формат материала по-русски. */
export const MATERIAL_FORMATS: Record<MaterialFormat, string> = {
  markdown: "Документ",
  link: "Внешняя ссылка",
};
/** Варианты формата материала. */
export const MATERIAL_FORMAT_OPTIONS: { value: MaterialFormat; label: string }[] = [
  { value: "markdown", label: MATERIAL_FORMATS.markdown },
  { value: "link", label: MATERIAL_FORMATS.link },
];
/** Название вида из реестра Contracts. */
const kindTitle = (kind: MaterialTargetKind): string =>
  entityDefinitions.find((definition) => definition.kind === kind)?.title ?? kind;
/** Названия 11 видов сущностей, к которым прикрепляются материалы. */
export const MATERIAL_TARGET_KINDS: Record<MaterialTargetKind, string> = {
  project: kindTitle("project"),
  product: kindTitle("product"),
  feature: kindTitle("feature"),
  scenario: kindTitle("scenario"),
  application: kindTitle("application"),
  implementation: kindTitle("implementation"),
  board: kindTitle("board"),
  task: kindTitle("task"),
  document: kindTitle("document"),
  "work-plan": kindTitle("work-plan"),
  release: kindTitle("release"),
};
/** Ограничения тегов из контракта: не более 20 тегов по 50 символов. */
export const MATERIAL_TAG_LIMITS = { count: 20, length: 50 };
