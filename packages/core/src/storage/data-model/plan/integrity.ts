import { entityAddress } from "@relay/contracts/entities/graph";
import type { EntityRef } from "@relay/contracts/entities/graph";
import type { JsonValue, StoredKeySpace, StoredRecord } from "@relay/contracts/storage";
import type { StorageBlocker } from "@relay/contracts/storage-maintenance";
import type { TransitionRegistry } from "../registry.js";
import { sourceBlocker } from "../source/reader.js";
import { recordReferences } from "./references.js";
import type { RecordReference } from "./references.js";

/**
 * Единая полная проверка согласованности постоянного набора формата 4 (ТЗ 5.1, 6.1, A02/A16).
 *
 * Одна функция обслуживает и явную диагностику текущей базы (`status`, dry-run и no-op
 * `migrate` через reader источника), и итог подготовки миграции в памяти: no-op не может
 * пропустить то, что блокирует изменяющий перенос. Вход — компактные факты записей (адреса,
 * ссылки по правилам владельцев, согласованность комментариев), собранные наборы отношений,
 * пространства ключей и идентичность проекта из конфигурации; значения записей не удерживаются.
 *
 * Проверяется: уникальность ключей и алиасов адресуемых видов; комментарии задачи; предметные
 * ссылки `EntityCodec.references` (запись или надгробие) и взаимность объявленных обратных
 * ссылок; владельцы пространств ключей; концы активных рёбер — действующие адресуемые записи;
 * глобальная уникальность ID рёбер; `config.projectId` — действующая запись проекта.
 */

export type RecordFacts = {
  readonly kind: string;
  readonly id: string;
  /** Относительный путь записи (адрес блокера). */
  readonly path: string;
  readonly live: boolean;
  /** Вид адресуемый: ключ и алиасы уникальны, действующая запись — конец активного ребра. */
  readonly addressable: boolean;
  /** Ключ и алиасы (для неадресуемых видов пусто). */
  readonly addresses: readonly string[];
  readonly refs: readonly RecordReference[];
  /** Комментарии задачи без повторов ID/номеров и без разрыва последовательности. */
  readonly commentsConsistent: boolean;
};

export type IntegrityInput = {
  readonly records: Iterable<RecordFacts>;
  readonly relations: Iterable<{ readonly owner: EntityRef; readonly value: JsonValue }>;
  readonly keyspaces: Iterable<StoredKeySpace>;
  /** Конфигурация проекта: путь и значение projectId; null — не проверяется. */
  readonly config: { readonly path: string; readonly projectId: string | null } | null;
};

/** Факты записи, прошедшей схему своей версии. */
export function recordFacts(
  record: StoredRecord,
  path: string,
  registry: TransitionRegistry,
): RecordFacts {
  const live = !("deleted" in record);
  const addressable = registry.catalog.entry(record.kind)?.addressable ?? false;
  let commentsConsistent = true;
  if (live && record.kind === "task") {
    const comments = (record as { comments?: { id: string; sequence: number }[] }).comments ?? [];
    const ids = new Set(comments.map((comment) => comment.id));
    const sequences = new Set(comments.map((comment) => comment.sequence));
    const max = comments.reduce((top, comment) => Math.max(top, comment.sequence), 0);
    const sequence = (record as { commentSequence?: number }).commentSequence ?? 0;
    commentsConsistent =
      ids.size === comments.length && sequences.size === comments.length && sequence >= max;
  }
  return {
    kind: record.kind,
    id: record.id,
    path,
    live,
    addressable,
    addresses: addressable
      ? [record.key, ...record.aliases].filter((value): value is string => value !== null)
      : [],
    refs: recordReferences(record, registry.storage),
    commentsConsistent,
  };
}

type Edge = {
  id: string;
  active: boolean;
  from?: { kind?: unknown; id?: unknown };
  to?: { kind?: unknown; id?: unknown };
};

const short = (id: string) => id.slice(0, 256);
const byText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export function integrityBlockers(
  input: IntegrityInput,
  registry: TransitionRegistry,
): StorageBlocker[] {
  const blockers: StorageBlocker[] = [];
  const records = [...input.records].sort((a, b) =>
    byText(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`),
  );
  const byAddress = new Map(records.map((record) => [`${record.kind}:${record.id}`, record]));

  // Адреса и комментарии.
  const owners = new Map<string, string>();
  for (const record of records) {
    const address = `${record.kind}:${record.id}`;
    for (const value of record.addresses) {
      const other = owners.get(value);
      if (other !== undefined && other !== address)
        blockers.push(
          sourceBlocker("STORAGE_ADDRESS_COLLISION", "Ключ или алиас принадлежит двум записям", {
            path: record.path,
            owner: record.kind,
            id: short(record.id),
            ...(value.length <= 64 ? { current: value } : {}),
          }),
        );
      else owners.set(value, address);
    }
    if (!record.commentsConsistent)
      blockers.push(
        sourceBlocker(
          "STORAGE_MIGRATION_CONFLICT",
          "Комментарии задачи имеют повторы или разрыв последовательности",
          { path: record.path, owner: record.kind, id: short(record.id) },
        ),
      );
  }

  // Предметные ссылки по правилам владельцев и их взаимность. Индекс ссылок
  // «источник\0поле\0цель» делает проверку обратной ссылки O(1), а весь проход — линейным.
  const linked = new Set<string>();
  for (const record of records)
    for (const ref of record.refs)
      linked.add(`${record.kind}:${record.id}\0${ref.field}\0${ref.kind}:${ref.id}`);
  for (const record of records)
    for (const ref of record.refs) {
      const target = byAddress.get(`${ref.kind}:${ref.id}`);
      if (!target) {
        blockers.push(
          sourceBlocker(
            "STORAGE_REFERENCE_BROKEN",
            `Поле ${ref.field} ссылается на отсутствующую запись вида ${ref.kind}`,
            { path: record.path, owner: record.kind, id: short(record.id) },
          ),
        );
        continue;
      }
      if (ref.inverse === undefined || !target.live) continue;
      const inverse = ref.inverse;
      if (!linked.has(`${ref.kind}:${ref.id}\0${inverse}\0${record.kind}:${record.id}`))
        blockers.push(
          sourceBlocker(
            "STORAGE_REFERENCE_BROKEN",
            `Поле ${ref.field} не подтверждено обратной ссылкой ${inverse} записи вида ${ref.kind}`,
            { path: record.path, owner: record.kind, id: short(record.id) },
          ),
        );
    }

  // Владельцы пространств ключей.
  for (const space of [...input.keyspaces].sort((a, b) => byText(a.id, b.id)))
    if (!byAddress.has(`${space.owner.kind}:${space.owner.id}`))
      blockers.push(
        sourceBlocker(
          "STORAGE_REFERENCE_BROKEN",
          `Поле owner ссылается на отсутствующую запись вида ${space.owner.kind}`,
          { path: `keyspaces/${space.id}.json`, id: short(space.id) },
        ),
      );

  // Рёбра: глобально уникальные ID, концы активных — действующие адресуемые записи.
  const edges = new Map<string, string>();
  const sets = [...input.relations].sort((a, b) =>
    byText(entityAddress(a.owner), entityAddress(b.owner)),
  );
  for (const { owner, value } of sets) {
    const collection = registry.catalog.entry(owner.kind)?.collection ?? owner.kind;
    const path = `relations/${collection}/${owner.id}.json`;
    const entries =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value.entries as { edge?: Edge }[] | undefined)
        : undefined;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const edge = entry.edge;
      if (!edge || typeof edge.id !== "string") continue;
      const holder = edges.get(edge.id);
      if (holder !== undefined)
        blockers.push(
          sourceBlocker(
            "STORAGE_ADDRESS_COLLISION",
            "ID связи занят другим владельцем или повторён",
            {
              path,
              owner: owner.kind,
              id: short(edge.id),
            },
          ),
        );
      else edges.set(edge.id, entityAddress(owner));
      if (!edge.active) continue;
      for (const end of [edge.from, edge.to]) {
        const record = byAddress.get(`${String(end?.kind)}:${String(end?.id)}`);
        if (!record || !record.live || !record.addressable)
          blockers.push(
            sourceBlocker(
              "STORAGE_REFERENCE_BROKEN",
              "Активная связь ссылается на отсутствующую сущность",
              { path, owner: owner.kind, id: short(edge.id) },
            ),
          );
      }
    }
  }

  // Идентичность проекта: настройки читаются по config.projectId (по умолчанию `project`).
  // Только для реестра с видом проекта (синтетические реестры тестов его не имеют).
  if (input.config && registry.catalog.entry("project")) {
    const id = input.config.projectId ?? "project";
    const project = byAddress.get(`project:${id}`);
    if (!project || !project.live)
      blockers.push(
        sourceBlocker(
          "STORAGE_REFERENCE_BROKEN",
          "Поле projectId конфигурации не указывает на действующую запись проекта",
          { path: input.config.path, owner: "project", id: short(id) },
        ),
      );
  }
  return blockers;
}

/** projectId сырой конфигурации; null — поля нет. */
export function configProjectId(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).projectId;
  return typeof id === "string" ? id : null;
}
