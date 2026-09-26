import type { z } from "zod";
import {
  storedEntitySchema,
  storedRecordSchema,
  storageCardSchema,
  storageKindDefinitionSchema,
} from "@relay/contracts/storage";
import type { StoredEntity, StoredRecord, StorageCard, JsonValue } from "@relay/contracts/storage";
import type { EntityRef } from "@relay/contracts/entities/graph";
import { invariant } from "../../shared/errors.js";

export type EntityCodec = {
  kind: string;
  collection: string;
  dataVersion: number;
  /** Технический владелец сохраняет состояние и ID, но не занимает публичные ключи и каталог. */
  addressable?: boolean;
  indexes?(record: EntityRecord): { index: string; key: string; value: JsonValue }[];
  schema: z.ZodType<Record<string, unknown>>;
  encode(data: Record<string, unknown>): Record<string, JsonValue>;
  decode(data: Record<string, JsonValue>): Record<string, unknown>;
  /** Явные переходы версии N → N+1 над дисковыми данными; чтение их автоматически не запускает. */
  migrations?: Readonly<
    Record<number, (data: Record<string, JsonValue>) => Record<string, JsonValue>>
  >;
  card(
    record: EntityRecord,
  ): Pick<StorageCard, "title" | "status" | "selectors"> &
    Partial<Pick<StorageCard, "summary" | "active" | "context" | "document">>;
};
export type EntityRecord = Omit<StoredEntity, "data" | "schemaVersion"> & {
  data: Record<string, unknown>;
  /** Вход предметных адаптеров; на диск всегда записывается оболочка 3. */
  schemaVersion: 1 | 2 | 3;
};

/** Виды регистрируют кодеки; общий алгоритм пути и резолвер не перечисляют предметные виды. */
export class EntityStorageRegistry {
  private readonly codecs = new Map<string, EntityCodec>();

  constructor(definitions: readonly EntityCodec[]) {
    for (const definition of definitions) {
      storageKindDefinitionSchema.parse({
        kind: definition.kind,
        collection: definition.collection,
        dataVersion: definition.dataVersion,
      });
      invariant(
        !this.codecs.has(definition.kind) &&
          ![...this.codecs.values()].some((entry) => entry.collection === definition.collection),
        "DUPLICATE_STORAGE_KIND",
        "Вид или коллекция хранения уже зарегистрированы",
        5,
      );
      this.codecs.set(definition.kind, definition);
    }
  }

  definitions(): readonly EntityCodec[] {
    return [...this.codecs.values()];
  }

  definition(kind: string): EntityCodec {
    const definition = this.codecs.get(kind);
    invariant(definition, "UNKNOWN_ENTITY_KIND", `Вид ${kind} не зарегистрирован в хранилище`, 4);
    return definition;
  }

  path(ref: EntityRef): string {
    // Проверяем ID той же переносимой схемой, включая старые допустимые идентификаторы.
    const id = storedEntitySchema.shape.id.parse(ref.id);
    return `entities/${this.definition(ref.kind).collection}/${id}.json`;
  }

  encode(record: EntityRecord): StoredEntity {
    const codec = this.definition(record.kind);
    invariant(
      record.dataVersion === codec.dataVersion,
      "STORAGE_DATA_MIGRATION_REQUIRED",
      "Версия данных вида требует явной миграции",
      4,
    );
    const stored = storedEntitySchema.parse({
      ...record,
      schemaVersion: 3,
      data: codec.encode(codec.schema.parse(record.data)),
    });
    this.validate(stored);
    return stored;
  }

  validate(value: unknown): StoredRecord {
    const record = storedRecordSchema.parse(value);
    const codec = this.definition(record.kind);
    invariant(
      record.kind === "task" ||
        (record.comments === undefined && record.commentSequence === undefined),
      "INVALID_DATA",
      "Лента комментариев допустима только у задачи",
      5,
    );
    if (record.comments !== undefined) {
      let sequence = 0;
      for (const comment of record.comments) {
        invariant(
          comment.taskId === record.id &&
            comment.id === String(comment.sequence) &&
            comment.sequence > sequence,
          "INVALID_DATA",
          "Неверная принадлежность или порядок комментариев",
          5,
        );
        sequence = comment.sequence;
      }
      invariant(
        record.commentSequence !== undefined && record.commentSequence >= sequence,
        "INVALID_DATA",
        "Потерян максимальный номер ленты комментариев",
        5,
      );
    }
    invariant(
      codec.addressable === false
        ? record.key === null && record.aliases.length === 0
        : record.key !== null,
      "INVALID_DATA",
      "Ключ не соответствует публичности владельца",
      5,
    );
    invariant(
      record.dataVersion === codec.dataVersion,
      "STORAGE_DATA_MIGRATION_REQUIRED",
      "Версия данных вида требует явной миграции",
      4,
    );
    invariant(
      new Set(record.aliases).size === record.aliases.length,
      "INVALID_DATA",
      "Алиас сущности повторяется",
      5,
    );
    if (!("deleted" in record)) codec.schema.parse(codec.decode(record.data));
    return record;
  }

  decode(value: unknown): EntityRecord {
    const record = this.validate(value);
    invariant(
      !("deleted" in record),
      "ENTITY_DELETED",
      "Сущность удалена; адрес зарезервирован",
      3,
    );
    const codec = this.definition(record.kind);
    return { ...record, data: codec.schema.parse(codec.decode(record.data)) };
  }

  /** Подготовка явной миграции вида сохраняет ID, ревизию, авторство и даты. */
  migrate(value: unknown): StoredRecord {
    const record = storedRecordSchema.parse(value);
    const codec = this.definition(record.kind);
    invariant(
      record.dataVersion <= codec.dataVersion,
      "STORAGE_DATA_MIGRATION_REQUIRED",
      "Версия данных новее поддерживаемой; обратная миграция не выполняется",
      4,
    );
    while (record.dataVersion < codec.dataVersion) {
      if (!("deleted" in record)) {
        const step = codec.migrations?.[record.dataVersion];
        invariant(
          step,
          "STORAGE_DATA_MIGRATION_REQUIRED",
          "Для версии данных не зарегистрирован переход",
          4,
        );
        record.data = step(structuredClone(record.data));
      }
      record.dataVersion++;
    }
    return this.validate(record);
  }

  card(record: StoredEntity): StorageCard {
    invariant(
      this.definition(record.kind).addressable !== false && record.key !== null,
      "ENTITY_NOT_FOUND",
      "Техническая запись не входит в публичный каталог сущностей",
      3,
    );
    return storageCardSchema.parse({
      ref: { kind: record.kind, id: record.id },
      key: record.key,
      aliases: record.aliases,
      revision: record.revision,
      ...this.definition(record.kind).card(this.decode(record)),
    });
  }
}
