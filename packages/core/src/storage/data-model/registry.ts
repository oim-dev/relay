import { createHash } from "node:crypto";
import { z } from "zod";
import { storedRecordSchema } from "@relay/contracts/storage";
import type { JsonValue, StoredRecord } from "@relay/contracts/storage";
import type { StorageLayout } from "@relay/contracts/storage-maintenance";
import { AppError } from "../../shared/errors.js";
import type { EntityStorageRegistry } from "../entity-store/registry.js";
import { canonical, jsonHash } from "../entity-store/format.js";
import { registryError, storageError } from "./errors.js";
import type { HistoricalKindCatalog } from "./history/catalog.js";
import type { DataModelProfile } from "./profiles.js";
import type {
  DataTransition,
  DiskData,
  PhysicalTransition,
  RecordTransition,
  SnapshotTransition,
  VersionValidator,
} from "./types.js";

export type TransitionRegistryInput = {
  readonly profiles: readonly DataModelProfile[];
  readonly transitions: readonly DataTransition[];
  readonly physical?: readonly PhysicalTransition[];
  readonly storage: EntityStorageRegistry;
  readonly historical: HistoricalKindCatalog;
  /**
   * Схема конфигурации целевого профиля: итог миграции должен открываться обычным
   * `Workspace`. Без схемы конфигурация не проверяется (синтетические реестры тестов).
   */
  readonly config?: z.ZodType;
};

/** Фактический набор версий по видам: вид → версии данных, найденные в записях. */
export type PresentVersions = ReadonlyMap<string, ReadonlySet<number>>;
export type Target = number | "removed";

const ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,127}$/;
const node = (kind: string, version: number) => `${kind}@${version}`;

/** Входные узлы (вид, версия) перехода. */
function inputs(transition: DataTransition): [string, number][] {
  return transition.type === "record"
    ? [[transition.owner, transition.from]]
    : Object.entries(transition.requires);
}

/** Выходные узлы (вид, версия); удаление вида узла не создаёт. */
function outputs(transition: DataTransition): [string, number][] {
  return transition.type === "record"
    ? [[transition.owner, transition.to]]
    : Object.entries(transition.produces).filter(
        (entry): entry is [string, number] => entry[1] !== "removed",
      );
}

/** Затрагиваемые владельцы шага по алфавиту. */
export function transitionOwners(transition: DataTransition): string[] {
  return transition.type === "record"
    ? [transition.owner]
    : [
        ...new Set([...Object.keys(transition.requires), ...Object.keys(transition.produces)]),
      ].sort();
}

/** JSON Schema без описаний: сравнение структуры, а не текста подсказок. */
export function schemaShape(schema: z.ZodType): JsonValue {
  const strip = (value: unknown): JsonValue => {
    if (Array.isArray(value)) return value.map(strip);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== "description" && key !== "$schema")
          .map(([key, entry]) => [key, strip(entry)]),
      );
    return value as JsonValue;
  };
  return canonical(
    strip(z.toJSONSchema(schema, { unrepresentable: "any", cycles: "ref", reused: "inline" })),
  );
}
const sameShape = (left: z.ZodType, right: z.ZodType) =>
  jsonHash(schemaShape(left)) === jsonHash(schemaShape(right));

/** Детерминированный технический ID нового объекта перехода в формате UUID v8. */
export function deterministicId(transitionId: string, seed: string): string {
  const bytes = createHash("sha256")
    .update(`relay:migration:${transitionId}:${seed}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Применение record-перехода к одной записи: проверка входа замороженной схемой версии from,
 * чистая функция, проверка выхода схемой версии to. Оболочка (ID, ключи, ревизия, даты)
 * не меняется; надгробие получает только новую dataVersion.
 */
export function applyRecordTransition(
  transition: RecordTransition,
  record: StoredRecord,
): StoredRecord {
  if (record.kind !== transition.owner || record.dataVersion !== transition.from)
    throw storageError("STORAGE_TRANSITION_MISSING", "Переход не применим к версии записи", {
      step: transition.id,
      owner: record.kind,
      id: record.id,
      current: record.dataVersion,
      expected: transition.from,
    });
  if ("deleted" in record) return { ...structuredClone(record), dataVersion: transition.to };
  const input = transition.input.safeParse(record.data);
  if (!input.success)
    throw storageError(
      "STORAGE_DATA_CORRUPT",
      "Данные записи не соответствуют исторической схеме версии",
      {
        reason: "input",
        step: transition.id,
        owner: record.kind,
        id: record.id,
        current: record.dataVersion,
      },
    );
  const { data, ...envelope } = structuredClone(record);
  let result: unknown;
  try {
    result = transition.apply(data, { ref: { kind: record.kind, id: record.id }, envelope });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw storageError("STORAGE_TRANSITION_OUTPUT_INVALID", "Шаг перехода завершился ошибкой", {
      step: transition.id,
      owner: record.kind,
      id: record.id,
      expected: transition.to,
    });
  }
  if (!z.json().safeParse(result).success || !transition.output.safeParse(result).success)
    throw storageError(
      "STORAGE_TRANSITION_OUTPUT_INVALID",
      "Результат шага не соответствует схеме целевой версии",
      { step: transition.id, owner: record.kind, id: record.id, expected: transition.to },
    );
  return { ...structuredClone(record), dataVersion: transition.to, data: result as DiskData };
}

/**
 * Проверенный реестр переходов. Строится до работы с базой; все ошибки определения —
 * STORAGE_REGISTRY_INVALID с details.reason. Обход и планирование не ветвятся по видам и semver.
 */
export class TransitionRegistry {
  readonly profile: DataModelProfile;
  readonly digest: string;
  private readonly targets = new Map<string, Target>();
  private readonly edges = new Map<string, DataTransition>();
  private readonly byId = new Map<string, DataTransition>();
  private readonly physicalByLayout = new Map<string, PhysicalTransition>();

  constructor(private readonly input: TransitionRegistryInput) {
    const { profiles, transitions, storage, historical } = input;
    const physical = input.physical ?? [];
    this.checkProfiles(profiles);
    this.profile = profiles[profiles.length - 1]!;

    // Цели: текущий кодек хранения или удаление исторического вида.
    for (const entry of historical.entries())
      this.targets.set(entry.kind, entry.codec ? entry.codec.dataVersion : "removed");

    const current = Object.fromEntries(
      storage.definitions().map((codec) => [codec.kind, codec.dataVersion]),
    );
    if (jsonHash(canonical(current)) !== jsonHash(canonical({ ...this.profile.owners })))
      throw registryError(
        "profile-mismatch",
        "Целевой профиль не совпадает с зарегистрированными владельцами хранения",
        { current: this.profile.version },
      );
    for (const profile of profiles)
      for (const kind of Object.keys(profile.owners))
        if (!this.targets.has(kind))
          throw registryError("unknown-kind", "Профиль ссылается на неизвестный вид", {
            owner: kind,
            current: profile.version,
          });

    const ids = new Set<string>();
    for (const definition of [...transitions, ...physical]) {
      if (!ID_PATTERN.test(definition.id))
        throw registryError("invalid-id", "Недопустимый ID перехода", {
          id: definition.id.slice(0, 256) || "-",
        });
      if (ids.has(definition.id))
        throw registryError("duplicate-id", "ID перехода повторяется", { id: definition.id });
      ids.add(definition.id);
      if (!Number.isInteger(definition.version) || definition.version < 1)
        throw registryError(
          "invalid-version",
          "Версия определения перехода должна быть целым ≥ 1",
          {
            id: definition.id,
          },
        );
      if (definition.type === "physical") {
        if (this.physicalByLayout.has(definition.from))
          throw registryError("physical-duplicate", "Два физических перехода из одной раскладки", {
            id: definition.id,
            current: definition.from,
          });
        this.physicalByLayout.set(definition.from, definition);
        continue;
      }
      this.checkDefinition(definition);
      this.byId.set(definition.id, definition);
    }
    for (const definition of [...transitions, ...physical])
      for (const dependency of definition.dependsOn ?? [])
        if (!ids.has(dependency))
          throw registryError("unknown-dependency", "Зависимость перехода не зарегистрирована", {
            id: definition.id,
            expected: dependency.slice(0, 64),
          });

    this.checkCycles(transitions, physical);
    this.checkChains();
    this.checkSchemas();
    // Взаимная блокировка шагов обнаруживается на полном наборе известных версий.
    const everything = new Map<string, Set<number>>();
    for (const key of this.knownNodes()) {
      const [kind, version] = split(key);
      if (this.targets.get(kind) === version) continue;
      everything.set(kind, (everything.get(kind) ?? new Set()).add(version));
    }
    this.plan(everything);
    this.digest = this.computeDigest();
  }

  private checkProfiles(profiles: readonly DataModelProfile[]): void {
    if (!profiles.length)
      throw registryError("profile-invalid", "Не объявлен ни один профиль модели данных");
    let previous = 0;
    for (const profile of profiles) {
      if (!Number.isInteger(profile.version) || profile.version <= previous)
        throw registryError("profile-invalid", "Версии профилей должны строго возрастать", {
          current: profile.version,
        });
      for (const [kind, version] of Object.entries(profile.owners))
        if (!Number.isInteger(version) || version < 1)
          throw registryError(
            "profile-invalid",
            "Версия владельца в профиле должна быть целым ≥ 1",
            {
              owner: kind,
              current: profile.version,
            },
          );
      previous = profile.version;
    }
  }

  private checkDefinition(definition: DataTransition): void {
    const known = (kind: string) => {
      if (!this.targets.has(kind))
        throw registryError("unknown-kind", "Переход ссылается на неизвестный вид", {
          id: definition.id,
          owner: kind,
        });
    };
    const version = (kind: string, value: number) => {
      if (!Number.isInteger(value) || value < 1)
        throw registryError("invalid-version", "Версия данных должна быть целым ≥ 1", {
          id: definition.id,
          owner: kind,
        });
    };
    if (definition.type === "record") {
      known(definition.owner);
      version(definition.owner, definition.from);
      version(definition.owner, definition.to);
      if (definition.to !== definition.from + 1)
        throw registryError("non-adjacent", "Локальный переход записи должен быть N→N+1", {
          id: definition.id,
          owner: definition.owner,
          current: definition.from,
          expected: definition.from + 1,
        });
    } else {
      const requires = Object.entries(definition.requires);
      if (!requires.length)
        throw registryError("invalid-version", "Snapshot-переход не объявил входных владельцев", {
          id: definition.id,
        });
      for (const [kind, from] of requires) {
        known(kind);
        version(kind, from);
        const to = definition.produces[kind];
        if (to === undefined)
          throw registryError(
            "non-monotonic",
            "Входной владелец snapshot-перехода не получил выход",
            {
              id: definition.id,
              owner: kind,
            },
          );
        if (to !== "removed" && to <= from)
          throw registryError("non-monotonic", "Версия выхода должна быть больше версии входа", {
            id: definition.id,
            owner: kind,
            current: from,
            expected: to,
          });
        if (!definition.inputs[kind])
          throw registryError("output-mismatch", "Нет входной схемы владельца", {
            id: definition.id,
            owner: kind,
          });
      }
      for (const [kind, to] of Object.entries(definition.produces)) {
        known(kind);
        if (to === "removed") {
          if (this.targets.get(kind) !== "removed")
            throw registryError(
              "removed-current",
              "Удалять можно только вид вне текущего реестра",
              {
                id: definition.id,
                owner: kind,
              },
            );
          continue;
        }
        version(kind, to);
        if (!definition.outputs[kind])
          throw registryError("output-mismatch", "Нет выходной схемы владельца", {
            id: definition.id,
            owner: kind,
          });
      }
      for (const kind of Object.keys(definition.inputs))
        if (!(kind in definition.requires)) known(kind);
      for (const kind of Object.keys(definition.outputs))
        if (typeof definition.produces[kind] !== "number")
          throw registryError("output-mismatch", "Выходная схема объявлена без версии выхода", {
            id: definition.id,
            owner: kind,
          });
    }
    for (const [kind, from] of inputs(definition)) {
      const key = node(kind, from);
      const other = this.edges.get(key);
      if (other)
        throw registryError("ambiguous", "Два перехода из одной версии владельца", {
          id: definition.id,
          owner: kind,
          current: from,
          expected: other.id,
        });
      this.edges.set(key, definition);
    }
    for (const [kind, version] of [...inputs(definition), ...outputs(definition)]) {
      const target = this.targets.get(kind);
      if (typeof target === "number" && version > target)
        throw registryError("beyond-target", "Переход объявляет версию выше целевой", {
          id: definition.id,
          owner: kind,
          current: version,
          expected: target,
        });
    }
  }

  /** Циклы по узлам (вид, версия) и по dependsOn. */
  private checkCycles(
    transitions: readonly DataTransition[],
    physical: readonly PhysicalTransition[],
  ): void {
    const state = new Map<string, 1 | 2>();
    const visit = (key: string, via: string | undefined): void => {
      const mark = state.get(key);
      if (mark === 2) return;
      if (mark === 1)
        throw registryError("cycle", "Цикл в реестре переходов", {
          ...(via ? { id: via } : {}),
          current: key.slice(0, 64),
        });
      state.set(key, 1);
      const edge = this.edges.get(key);
      if (edge) for (const [kind, version] of outputs(edge)) visit(node(kind, version), edge.id);
      state.set(key, 2);
    };
    for (const key of this.knownNodes()) visit(key, undefined);

    const all = new Map<string, readonly string[]>(
      [...transitions, ...physical].map((entry) => [entry.id, entry.dependsOn ?? []]),
    );
    const marks = new Map<string, 1 | 2>();
    const depend = (id: string): void => {
      const mark = marks.get(id);
      if (mark === 2) return;
      if (mark === 1) throw registryError("cycle", "Цикл зависимостей переходов", { id });
      marks.set(id, 1);
      for (const dependency of all.get(id) ?? []) depend(dependency);
      marks.set(id, 2);
    };
    for (const id of all.keys()) depend(id);
  }

  /** Все узлы, объявленные профилями, входами и выходами переходов. */
  private knownNodes(): string[] {
    const keys = new Set<string>();
    for (const profile of this.input.profiles)
      for (const [kind, version] of Object.entries(profile.owners)) keys.add(node(kind, version));
    for (const transition of this.byId.values())
      for (const [kind, version] of [...inputs(transition), ...outputs(transition)])
        keys.add(node(kind, version));
    return [...keys].sort();
  }

  /** Разрыв: каждая известная версия ниже цели должна иметь путь до цели. */
  private checkChains(): void {
    for (const key of this.knownNodes()) {
      const [kind, start] = split(key);
      const target = this.targets.get(kind)!;
      let version: number | "removed" = start;
      while (version !== target) {
        if (version === "removed" || (typeof target === "number" && version > target))
          throw registryError("gap", "Цепочка владельца не приводит к целевой версии", {
            owner: kind,
            current: start,
            expected: target,
          });
        const edge = this.edges.get(node(kind, version));
        if (!edge)
          throw registryError("gap", "Разрыв цепочки переходов владельца", {
            owner: kind,
            current: version,
            expected: target,
          });
        version = edge.type === "record" ? edge.to : (edge.produces[kind] as number | "removed");
      }
    }
  }

  /** Выход шага совпадает со входом следующего шага и с дисковой схемой текущего кодека. */
  private checkSchemas(): void {
    for (const transition of this.byId.values())
      for (const [kind, version] of outputs(transition)) {
        const output = transition.type === "record" ? transition.output : transition.outputs[kind]!;
        const next = this.edges.get(node(kind, version));
        const expected = next
          ? next.type === "record"
            ? next.input
            : next.inputs[kind]
          : this.targets.get(kind) === version
            ? this.input.storage.definition(kind).diskSchema
            : undefined;
        if (expected && !sameShape(output, expected))
          throw registryError(
            "output-mismatch",
            "Выход шага не совпадает со входом следующей версии",
            {
              id: transition.id,
              owner: kind,
              current: version,
              ...(next ? { expected: next.id } : {}),
            },
          );
      }
  }

  private computeDigest(): string {
    const describe = (transition: DataTransition) =>
      transition.type === "record"
        ? {
            id: transition.id,
            version: transition.version,
            type: transition.type,
            owner: transition.owner,
            from: transition.from,
            to: transition.to,
            dependsOn: [...(transition.dependsOn ?? [])],
            input: schemaShape(transition.input),
            output: schemaShape(transition.output),
          }
        : {
            id: transition.id,
            version: transition.version,
            type: transition.type,
            requires: { ...transition.requires },
            produces: { ...transition.produces },
            dependsOn: [...(transition.dependsOn ?? [])],
            inputs: Object.fromEntries(
              Object.entries(transition.inputs).map(([kind, schema]) => [
                kind,
                schemaShape(schema),
              ]),
            ),
            outputs: Object.fromEntries(
              Object.entries(transition.outputs).map(([kind, schema]) => [
                kind,
                schemaShape(schema),
              ]),
            ),
          };
    const value = {
      algorithm: 1,
      profiles: this.input.profiles.map((profile) => ({
        ...profile,
        owners: { ...profile.owners },
      })),
      kinds: this.input.historical
        .entries()
        .map((entry) => ({
          kind: entry.kind,
          collection: entry.collection,
          addressable: entry.addressable,
          target: this.targets.get(entry.kind)!,
        }))
        .sort((left, right) => (left.kind < right.kind ? -1 : 1)),
      transitions: [...this.byId.values()]
        .sort((left, right) => (left.id < right.id ? -1 : 1))
        .map(describe),
      physical: [...this.physicalByLayout.values()]
        .sort((left, right) => (left.id < right.id ? -1 : 1))
        .map((entry) => ({
          id: entry.id,
          version: entry.version,
          from: entry.from,
          to: entry.to,
          dependsOn: [...(entry.dependsOn ?? [])],
        })),
    };
    return jsonHash(canonical(JSON.parse(JSON.stringify(value)) as JsonValue));
  }

  /** Конфигурация соответствует схеме целевого профиля (true без объявленной схемы). */
  validConfig(value: unknown): boolean {
    return this.input.config ? this.input.config.safeParse(value).success : true;
  }

  get storage(): EntityStorageRegistry {
    return this.input.storage;
  }

  get catalog(): HistoricalKindCatalog {
    return this.input.historical;
  }

  /** Целевая версия вида текущего профиля; removed — исторический вид. */
  target(kind: string): Target {
    const target = this.targets.get(kind);
    if (target === undefined)
      throw storageError("UNKNOWN_ENTITY_KIND", "Вид записи неизвестен реестру", kindDetail(kind));
    return target;
  }

  /** Вид по коллекции entities/<collection>; неизвестная коллекция — UNKNOWN_ENTITY_KIND. */
  kindOfCollection(collection: string): string {
    const kind = this.input.historical.kindOfCollection(collection);
    if (!kind)
      throw storageError("UNKNOWN_ENTITY_KIND", "Коллекция записей неизвестна реестру", {
        path: `entities/${collection}`.slice(0, 1024),
      });
    return kind;
  }

  transitions(): readonly DataTransition[] {
    return [...this.byId.values()];
  }

  transition(id: string): DataTransition | undefined {
    return this.byId.get(id);
  }

  /** Единственный переход из версии вида; undefined — версия целевая или перехода нет. */
  transitionFrom(kind: string, version: number): DataTransition | undefined {
    return this.edges.get(node(kind, version));
  }

  physicalFrom(layout: StorageLayout): PhysicalTransition | undefined {
    return this.physicalByLayout.get(layout);
  }

  /**
   * Валидатор дисковых данных версии: текущий кодек для целевой версии, входная схема перехода
   * для старой. Различимые отказы: неизвестный вид, версия новее, отсутствующий переход.
   */
  validator(kind: string, version: number): VersionValidator {
    const target = this.target(kind);
    if (version === target) {
      const storage = this.input.storage;
      return {
        kind,
        version,
        source: "current",
        parse(data) {
          try {
            return storage.currentData(kind, data);
          } catch {
            throw storageError("STORAGE_DATA_CORRUPT", "Данные записи не проходят текущую схему", {
              owner: kind,
              current: version,
            });
          }
        },
      };
    }
    if (typeof target === "number" && version > target)
      throw storageError("STORAGE_VERSION_UNSUPPORTED", "Версия данных новее поддерживаемой", {
        owner: kind,
        current: version,
        expected: target,
      });
    const edge = this.edges.get(node(kind, version));
    if (!edge)
      throw storageError(
        "STORAGE_TRANSITION_MISSING",
        "Для версии данных не зарегистрирован переход",
        {
          owner: kind,
          current: version,
          expected: target,
        },
      );
    const schema = edge.type === "record" ? edge.input : edge.inputs[kind]!;
    return {
      kind,
      version,
      source: "transition",
      parse(data) {
        if (!schema.safeParse(data).success)
          throw storageError(
            "STORAGE_DATA_CORRUPT",
            "Данные записи не соответствуют исторической схеме",
            {
              step: edge.id,
              owner: kind,
              current: version,
            },
          );
        return data;
      },
    };
  }

  /** Полная проверка записи любой поддерживаемой версии: оболочка и данные этой версии. */
  validateRecord(value: unknown): StoredRecord {
    const parsed = storedRecordSchema.safeParse(value);
    if (!parsed.success) throw storageError("STORAGE_DATA_CORRUPT", "Оболочка записи повреждена");
    const record = parsed.data;
    const entry = this.input.historical.entry(record.kind);
    if (!entry)
      throw storageError("UNKNOWN_ENTITY_KIND", "Вид записи неизвестен реестру", {
        ...kindDetail(record.kind),
        id: record.id,
      });
    try {
      this.input.storage.validateEnvelope(record, entry.addressable);
    } catch (error) {
      if (error instanceof AppError && error.code === "INVALID_DATA")
        throw storageError("STORAGE_DATA_CORRUPT", error.message, {
          owner: record.kind,
          id: record.id,
        });
      throw error;
    }
    const validator = this.validator(record.kind, record.dataVersion);
    if (!("deleted" in record)) {
      try {
        validator.parse(record.data);
      } catch (error) {
        if (error instanceof AppError && error.code === "STORAGE_DATA_CORRUPT")
          throw storageError("STORAGE_DATA_CORRUPT", error.message, {
            ...(error.details as object),
            id: record.id,
          } as never);
        throw error;
      }
    }
    return record;
  }

  /**
   * Детерминированный порядок шагов для фактических версий. Шаг готов, когда присутствует
   * хотя бы один его вход и никакой ещё возможный шаг не порождает его входных владельцев
   * в той же или меньшей версии; среди готовых выбирается наименьший ID.
   */
  plan(present: PresentVersions): DataTransition[] {
    const state = new Map<string, Set<number>>();
    for (const [kind, versions] of present) {
      if (!versions.size) continue;
      for (const version of versions) {
        const target = this.target(kind);
        if (version !== target) this.validator(kind, version);
      }
      state.set(kind, new Set(versions));
    }
    const steps: DataTransition[] = [];
    const pending = () =>
      [...state].some(([kind, versions]) =>
        [...versions].some((version) => version !== this.targets.get(kind)),
      );
    for (let guard = 0; pending(); guard++) {
      if (guard > 10_000) throw registryError("deadlock", "План переходов не сходится");
      const reachable = this.reachable(state);
      const possible = [...this.byId.values()].filter((transition) =>
        inputs(transition).some(([kind, version]) => reachable.has(node(kind, version))),
      );
      const ready = possible
        .filter((transition) => this.ready(transition, state, possible))
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      const next = ready[0];
      if (!next)
        throw registryError("deadlock", "Шаги переходов взаимно блокируют друг друга", {
          current: [...state.keys()].sort().join(",").slice(0, 64),
        });
      for (const [kind, version] of inputs(next)) {
        const versions = state.get(kind);
        if (!versions?.delete(version)) continue;
        const to = next.type === "record" ? next.to : next.produces[kind]!;
        if (to !== "removed") versions.add(to);
        if (!versions.size) state.delete(kind);
      }
      if (next.type === "snapshot")
        for (const [kind, to] of Object.entries(next.produces))
          if (!(kind in next.requires) && to !== "removed")
            state.set(kind, (state.get(kind) ?? new Set()).add(to));
      steps.push(next);
    }
    return steps;
  }

  private reachable(state: ReadonlyMap<string, ReadonlySet<number>>): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const [kind, versions] of state)
      for (const version of versions) queue.push(node(kind, version));
    while (queue.length) {
      const key = queue.pop()!;
      if (seen.has(key)) continue;
      seen.add(key);
      const edge = this.edges.get(key);
      if (!edge) continue;
      for (const [kind, version] of outputs(edge)) queue.push(node(kind, version));
      // Новые виды snapshot-перехода тоже становятся достижимыми.
    }
    return seen;
  }

  private ready(
    transition: DataTransition,
    state: ReadonlyMap<string, ReadonlySet<number>>,
    possible: readonly DataTransition[],
  ): boolean {
    const own = inputs(transition);
    if (!own.some(([kind, version]) => state.get(kind)?.has(version))) return false;
    for (const other of possible) {
      if (other === transition) continue;
      if ((transition.dependsOn ?? []).includes(other.id)) return false;
      for (const [kind, version] of outputs(other))
        if (own.some(([ownKind, ownVersion]) => ownKind === kind && version <= ownVersion))
          return false;
    }
    return true;
  }
}

function split(key: string): [string, number] {
  const at = key.lastIndexOf("@");
  return [key.slice(0, at), Number(key.slice(at + 1))];
}

function kindDetail(kind: string): { owner?: string } {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(kind) ? { owner: kind } : {};
}

export function createTransitionRegistry(input: TransitionRegistryInput): TransitionRegistry {
  return new TransitionRegistry(input);
}

export type { SnapshotTransition };
