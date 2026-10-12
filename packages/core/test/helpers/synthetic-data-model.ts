/**
 * Синтетическая модель данных только для тестов реестра переходов (A06/A07/A15/A29).
 * Производственный реестр фиктивных видов не получает.
 *
 * Вид note (коллекция notes): v1 {name,text,tags} → v2 переименование name→title →
 * v3 snapshot: вынос tags в отдельный вид tag (коллекция tags) → v4 разделение title
 * на title/subtitle и перенос text в Markdown-массив body. Профили 10..13.
 */
import { z } from "zod";
import type { JsonValue, StoredRecord } from "@relay/contracts/storage";
import type { EntityRef } from "@relay/contracts/entities/graph";
import { EntityStorageRegistry } from "../../src/storage/entity-store/registry.js";
import type { EntityCodec } from "../../src/storage/entity-store/registry.js";
import { HistoricalKindCatalog } from "../../src/storage/data-model/history/catalog.js";
import type { HistoricalKind } from "../../src/storage/data-model/history/catalog.js";
import type { DataModelProfile } from "../../src/storage/data-model/profiles.js";
import {
  applyRecordTransition,
  createTransitionRegistry,
  deterministicId,
} from "../../src/storage/data-model/registry.js";
import type {
  TransitionRegistry,
  TransitionRegistryInput,
} from "../../src/storage/data-model/registry.js";
import type {
  ChangeSet,
  DataTransition,
  DiskData,
  RecordTransition,
  SnapshotTransition,
  SnapshotView,
} from "../../src/storage/data-model/types.js";
import { storageError } from "../../src/storage/data-model/errors.js";

export const noteV1 = z.strictObject({
  name: z.string(),
  text: z.string(),
  tags: z.array(z.string()),
});
export const noteV2 = z.strictObject({
  title: z.string(),
  text: z.string(),
  tags: z.array(z.string()),
});
export const noteV3 = z.strictObject({
  title: z.string(),
  text: z.string(),
  tagIds: z.array(z.string()),
});
export const noteV4 = z.strictObject({
  title: z.string(),
  subtitle: z.string().nullable(),
  body: z.array(z.string()),
  tagIds: z.array(z.string()),
});
export const tagV1 = z.strictObject({ label: z.string() });

const disk = { 1: noteV1, 2: noteV2, 3: noteV3, 4: noteV4 } as const;

/** Кодек вида в заданной версии; дисковая схема — замороженная, v4 хранит body массивом строк. */
export function noteCodec(version: 1 | 2 | 3 | 4): EntityCodec {
  const decoded =
    version === 4
      ? z.strictObject({
          title: z.string(),
          subtitle: z.string().nullable(),
          body: z.string(),
          tagIds: z.array(z.string()),
        })
      : disk[version];
  return {
    kind: "note",
    collection: "notes",
    dataVersion: version,
    diskSchema: disk[version],
    schema: decoded as unknown as z.ZodType<Record<string, unknown>>,
    encode: (data) =>
      (version === 4 ? { ...data, body: String(data.body).split("\n") } : data) as Record<
        string,
        JsonValue
      >,
    decode: (data) =>
      version === 4 ? { ...data, body: (data.body as string[]).join("\n") } : { ...data },
    // Владелец сам регистрирует ссылки своих данных: метки по постоянным ID (A29).
    ...(version >= 3
      ? {
          references: (data: Record<string, JsonValue>) =>
            (Array.isArray(data.tagIds) ? data.tagIds : []).map((id) => ({
              field: "tagIds",
              kind: "tag",
              id,
            })),
        }
      : {}),
    card: (record) => ({
      title: String(record.data.title ?? record.data.name),
      status: "",
      selectors: [],
    }),
  };
}

export function simpleCodec(
  kind: string,
  version: number,
  schema: z.ZodType,
  addressable = true,
): EntityCodec {
  return {
    kind,
    collection: `${kind}s`,
    dataVersion: version,
    addressable,
    diskSchema: schema,
    schema: schema as z.ZodType<Record<string, unknown>>,
    encode: (data) => data as Record<string, JsonValue>,
    decode: (data) => ({ ...data }),
    card: () => ({ title: kind, status: "", selectors: [] }),
  };
}
export const tagCodec = () => simpleCodec("tag", 1, tagV1, false);

export const noteRename: RecordTransition = {
  id: "note-v1-to-v2",
  version: 1,
  type: "record",
  description: "Переименование name → title",
  owner: "note",
  from: 1,
  to: 2,
  input: noteV1,
  output: noteV2,
  apply: ({ name, ...data }) => ({ title: name!, ...data }),
};

export const noteTags: SnapshotTransition = {
  id: "note-tags-to-tag",
  version: 1,
  type: "snapshot",
  description: "Вынос меток заметки в отдельный вид tag",
  requires: { note: 2 },
  produces: { note: 3, tag: 1 },
  inputs: { note: noteV2 },
  outputs: { note: noteV3, tag: tagV1 },
  apply(view, changes) {
    const known = new Set(view.records("tag").map((record) => record.id));
    for (const record of view.records("note")) {
      if (record.dataVersion !== 2) continue;
      if ("deleted" in record) {
        changes.put({ ...record, dataVersion: 3 });
        continue;
      }
      const { tags, ...rest } = record.data as { title: string; text: string; tags: string[] };
      const tagIds = tags.map((label) => {
        const id = changes.newId(`tag:${label}`);
        if (!known.has(id)) {
          known.add(id);
          changes.put({
            schemaVersion: 3,
            dataVersion: 1,
            kind: "tag",
            id,
            revision: 1,
            key: null,
            aliases: [],
            data: { label },
            createdAt: record.createdAt,
            createdBy: record.createdBy,
            updatedAt: record.createdAt,
            updatedBy: record.createdBy,
          });
        }
        return id;
      });
      changes.put({ ...record, dataVersion: 3, data: { ...rest, tagIds } });
    }
  },
};

export const noteSplit: RecordTransition = {
  id: "note-v3-to-v4",
  version: 1,
  type: "record",
  description: "Разделение title на title/subtitle и перенос text в Markdown-массив",
  owner: "note",
  from: 3,
  to: 4,
  input: noteV3,
  output: noteV4,
  apply: (data) => {
    const title = data.title as string;
    const at = title.indexOf(": ");
    return {
      title: at < 0 ? title : title.slice(0, at),
      subtitle: at < 0 ? null : title.slice(at + 2),
      body: (data.text as string).split("\n"),
      tagIds: data.tagIds!,
    };
  },
};

const profileBase = {
  physical: 4,
  envelope: 3,
  keyspace: 1,
  relationSet: 1,
  indexState: 1,
  config: 1,
} as const;
export const SYNTHETIC_PROFILES: readonly DataModelProfile[] = [
  { ...profileBase, version: 10, owners: { note: 1 } },
  { ...profileBase, version: 11, owners: { note: 2 } },
  { ...profileBase, version: 12, owners: { note: 3, tag: 1 } },
  { ...profileBase, version: 13, owners: { note: 4, tag: 1 } },
];

export type SyntheticProfile = 10 | 11 | 12 | 13;

/** Составные части реестра выбранного профиля: тесты меняют их для инъекции ошибок. */
export function syntheticInput(
  profile: SyntheticProfile = 13,
  extra: { codecs?: EntityCodec[]; historical?: HistoricalKind[] } = {},
): TransitionRegistryInput & { codecs: EntityCodec[]; historicalKinds: HistoricalKind[] } {
  const note = (profile - 9) as 1 | 2 | 3 | 4;
  const codecs = [noteCodec(note), ...(profile >= 12 ? [tagCodec()] : []), ...(extra.codecs ?? [])];
  const historicalKinds: HistoricalKind[] = [
    ...(profile < 12
      ? [{ kind: "tag", collection: "tags", addressable: false, provenance: "синтетика" }]
      : []),
    ...(extra.historical ?? []),
  ];
  const storage = new EntityStorageRegistry(codecs);
  return {
    profiles: SYNTHETIC_PROFILES.filter((entry) => entry.version <= profile),
    transitions: [noteRename, noteTags, noteSplit].slice(0, profile - 10),
    storage,
    historical: new HistoricalKindCatalog(storage, historicalKinds),
    codecs,
    historicalKinds,
  };
}

export function syntheticRegistry(profile: SyntheticProfile = 13): TransitionRegistry {
  return createTransitionRegistry(syntheticInput(profile));
}

/** Пересобрать вход с другим набором определений (каталог и хранение те же). */
export function withTransitions(
  input: TransitionRegistryInput,
  transitions: readonly DataTransition[],
  profiles: readonly DataModelProfile[] = input.profiles,
): TransitionRegistryInput {
  return { ...input, transitions, profiles };
}

const stamp = "2024-01-02T03:04:05.000Z";
export function note(
  id: string,
  version: number,
  data: Record<string, JsonValue>,
  deleted = false,
): StoredRecord {
  const base = {
    schemaVersion: 3 as const,
    dataVersion: version,
    kind: "note",
    id,
    revision: 7,
    key: `NOTE-${id.toUpperCase()}`,
    aliases: [],
  };
  return deleted
    ? { ...base, deleted: { at: stamp, actor: "tester" } }
    : {
        ...base,
        data,
        createdAt: stamp,
        createdBy: "tester",
        updatedAt: stamp,
        updatedBy: "tester",
      };
}

const order = (left: StoredRecord, right: StoredRecord) =>
  `${left.kind}/${left.id}` < `${right.kind}/${right.id}` ? -1 : 1;

/**
 * Минимальный исполнитель в памяти для проверки реестра и плана (не исполнитель Core):
 * record-шаги применяются общей функцией applyRecordTransition, snapshot-шаги получают
 * только чтение и набор изменений; каждый выход проверяется схемой версии.
 */
export function runInMemory(
  registry: TransitionRegistry,
  source: readonly StoredRecord[],
): { records: StoredRecord[]; steps: string[] } {
  let records = source.map((record) => structuredClone(registry.validateRecord(record)));
  const present = new Map<string, Set<number>>();
  for (const record of records)
    present.set(record.kind, (present.get(record.kind) ?? new Set()).add(record.dataVersion));
  const steps = registry.plan(present);
  for (const step of steps) {
    if (step.type === "record") {
      records = records.map((record) =>
        record.kind === step.owner && record.dataVersion === step.from
          ? applyRecordTransition(step, record)
          : record,
      );
      continue;
    }
    const frozen = records.map((record) => Object.freeze(structuredClone(record)));
    const view: SnapshotView = {
      records: (kind) => frozen.filter((record) => record.kind === kind).sort(order),
      relations: () => null,
      keyspaces: () => [],
      project: () => ({ id: null }),
    };
    const puts = new Map<string, StoredRecord>();
    const removed = new Set<string>();
    const changes: ChangeSet = {
      put: (record) => void puts.set(`${record.kind}/${record.id}`, structuredClone(record)),
      remove: (ref: EntityRef) => void removed.add(`${ref.kind}/${ref.id}`),
      relations: () => undefined,
      removeSource: () => undefined,
      newId: (seed) => deterministicId(step.id, seed),
    };
    step.apply(view, changes);
    for (const record of puts.values()) {
      const expected = step.produces[record.kind];
      const schema = step.outputs[record.kind];
      if (
        typeof expected !== "number" ||
        record.dataVersion !== expected ||
        !schema ||
        (!("deleted" in record) && !schema.safeParse(record.data).success)
      )
        throw storageError("STORAGE_TRANSITION_OUTPUT_INVALID", "Неверный выход snapshot-шага", {
          step: step.id,
          owner: record.kind,
          id: record.id,
        });
    }
    records = [
      ...records.filter((record) => {
        const key = `${record.kind}/${record.id}`;
        return !puts.has(key) && !removed.has(key);
      }),
      ...puts.values(),
    ];
    for (const record of records)
      if (step.requires[record.kind] === record.dataVersion)
        throw storageError(
          "STORAGE_TRANSITION_OUTPUT_INVALID",
          "Snapshot-шаг оставил запись входной версии",
          {
            step: step.id,
            owner: record.kind,
            id: record.id,
          },
        );
  }
  for (const record of records) {
    registry.validateRecord(record);
    if (record.dataVersion !== registry.target(record.kind))
      throw storageError("STORAGE_TRANSITION_OUTPUT_INVALID", "Запись не достигла целевой версии", {
        owner: record.kind,
        id: record.id,
      });
  }
  return { records: records.sort(order), steps: steps.map((step) => `${step.id}@${step.version}`) };
}

export const bytes = (records: readonly StoredRecord[]) => JSON.stringify(records, null, 2);
export type { DiskData };
