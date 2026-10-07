import type { StoredRecord } from "@relay/contracts/storage";
import type { EntityStorageRegistry } from "../../entity-store/registry.js";

/**
 * Проверка предметных ссылок итогового набора (ТЗ 6.1, A16, A29). Движок не знает полей
 * видов: он обходит зарегистрированные владельцами правила `EntityCodec.references` для
 * записей текущей версии кодека и владельцев пространств ключей. Ссылка обязана указывать
 * на существующую запись вида — действующую или надгробие (удаление не стирает адрес);
 * наличие ребра не заменяет проверку. Сервисы владельцев проверяют то же при записи, но
 * работают через открытый `Workspace`, а подготовленный результат существует только в памяти.
 * Сама проверка существования и взаимности — в `integrity.ts`.
 */

export type BrokenReference = {
  /** Вид записи-источника или `keyspace`. */
  readonly owner: string;
  readonly id: string;
  /** Поле данных с разорванной ссылкой (имя схемы, без пользовательского текста). */
  readonly field: string;
  readonly target: string;
};

/** Ссылка записи: поле, вид и ID цели; `inverse` — поле цели, обязанное ссылаться обратно. */
export type RecordReference = {
  readonly field: string;
  readonly kind: string;
  readonly id: string;
  readonly inverse?: string;
};

/** Ссылки действующей записи текущей версии кодека по правилам её владельца. */
export function recordReferences(
  record: StoredRecord,
  storage: EntityStorageRegistry,
): RecordReference[] {
  if ("deleted" in record) return [];
  let codec;
  try {
    codec = storage.definition(record.kind);
  } catch {
    return [];
  }
  // Правила описывают текущую форму; записи прежних версий проверяются после переходов.
  if (!codec.references || record.dataVersion !== codec.dataVersion) return [];
  const output = new Map<string, RecordReference>();
  for (const ref of codec.references(record.data)) {
    if (ref.id === null || ref.id === undefined) continue;
    const id = typeof ref.id === "string" ? ref.id : JSON.stringify(ref.id);
    output.set(`${ref.field}\0${ref.kind}\0${id}`, {
      field: ref.field,
      kind: ref.kind,
      id,
      ...(ref.inverse === undefined ? {} : { inverse: ref.inverse }),
    });
  }
  return [...output.values()];
}
