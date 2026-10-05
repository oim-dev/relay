import {
  DocumentAccessError,
  DocumentConflictError,
  DocumentRelationError,
} from "domains/documents";

/**
 * Переводит ожидаемый отказ изменения связи в объяснение с дальнейшим действием.
 * Неожиданная ошибка возвращается как undefined: её владелец — граница ошибок.
 */
export const describeRelationFailure = (failure: unknown): string | undefined => {
  if (failure instanceof DocumentConflictError)
    return "Материал изменился после чтения. Блок обновлён — проверьте связь и повторите действие.";
  if (failure instanceof DocumentRelationError && failure.code === "RELATION_NOT_FOUND")
    return "Этой связи уже нет: её сняли в другом месте. Блок обновлён.";
  if (failure instanceof DocumentRelationError && failure.code === "ALREADY_EXISTS")
    return "У материала уже есть связь с этой сущностью такого типа. Выберите другой тип.";
  if (failure instanceof DocumentAccessError) return failure.message;
  return undefined;
};
