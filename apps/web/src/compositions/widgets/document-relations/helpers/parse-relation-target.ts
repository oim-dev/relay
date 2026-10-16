import { MATERIAL_TARGET_KINDS } from "domains/documents";
import type { DocumentRelation, MaterialTargetKind } from "domains/documents";
import { isRelocatedEntityKind } from "domains/entities";

/** Проверяет вид сущности, к которой можно прикрепить материал; прежние адреса исключены. */
const isTargetKind = (kind: string): kind is MaterialTargetKind =>
  kind in MATERIAL_TARGET_KINDS && !isRelocatedEntityKind(kind);

/** Разбирает адрес выбранной сущности `kind:id`; null — вид не поддерживает прикрепление. */
export const parseRelationTarget = (address: string): DocumentRelation["target"] | null => {
  const separator = address.indexOf(":");
  if (separator <= 0) return null;
  const kind = address.slice(0, separator);
  const id = address.slice(separator + 1);
  return isTargetKind(kind) && id !== "" ? { kind, id } : null;
};
