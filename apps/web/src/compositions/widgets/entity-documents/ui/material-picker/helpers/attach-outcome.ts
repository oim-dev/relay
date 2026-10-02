import {
  DocumentAccessError,
  DocumentConflictError,
  DocumentRelationError,
} from "domains/documents";
import type { AttachOutcome } from "../types/attach-outcome.type";

/**
 * Переводит отказ прикрепления одного материала в итог строки.
 * Неожиданная ошибка возвращается как undefined: её владелец — граница ошибок.
 */
export const toFailedOutcome = (
  material: { id: string; title: string },
  failure: unknown,
): AttachOutcome | undefined => {
  if (failure instanceof DocumentRelationError && failure.code === "ALREADY_EXISTS")
    return { ...material, status: "exists", message: "Уже прикреплён с этим типом связи." };
  if (failure instanceof DocumentConflictError)
    return {
      ...material,
      status: "conflict",
      message: "Материал изменился после чтения. Проверьте его и выберите снова.",
    };
  if (failure instanceof DocumentAccessError)
    return { ...material, status: "error", message: failure.message };
  return undefined;
};
