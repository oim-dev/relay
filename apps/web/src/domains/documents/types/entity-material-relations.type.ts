import type { DocumentRelation } from "./document.type";

/** Смысл связи материала с сущностью; совместимая область links читается как documents. */
export type MaterialRelationType = DocumentRelation["type"];
/**
 * Полный набор связей материалов вне архива с одной сущностью: ID материала → типы связей.
 * Отсутствие ID означает, что прямой связи нет, — только в полностью прочитанном наборе.
 * Обычный объект, а не Map: кеш сравнивает данные по собственным ключам, и разные Map
 * считались бы равными, обновление не отображалось бы.
 */
export type EntityMaterialRelations = Readonly<Record<string, MaterialRelationType[]>>;
