/**
 * Замороженные профили модели данных. Профиль не вычисляется из текущих кодеков:
 * повышение dataVersion любого владельца требует нового профиля (проверяет реестр и тест).
 */
export type DataModelProfile = {
  /** Значение storage.json.dataModelVersion; профиль 1 записан отсутствием поля. */
  readonly version: number;
  readonly physical: 4;
  readonly envelope: 3;
  readonly keyspace: 1;
  readonly relationSet: 1;
  readonly indexState: 1;
  readonly config: 1;
  /** Вид → целевой dataVersion; виды вне карты в этом профиле отсутствуют. */
  readonly owners: Readonly<Record<string, number>>;
};

const base = {
  physical: 4,
  envelope: 3,
  keyspace: 1,
  relationSet: 1,
  indexState: 1,
  config: 1,
} as const;

/** Состояние Relay 0.9.2: manifest формата 4 без dataModelVersion. Только исторический reader. */
export const PROFILE_1: DataModelProfile = Object.freeze({
  ...base,
  version: 1,
  owners: Object.freeze({
    "work-plan": 2,
    release: 2,
    project: 1,
    product: 1,
    feature: 1,
    scenario: 1,
    application: 1,
    implementation: 1,
    board: 1,
    task: 1,
    document: 1,
    scope: 1,
  }),
});

/**
 * Профиль 2: первая версия с обязательным маркером и адресами совместимости
 * прежних этапов plan-stage (dataVersion 2) и историческими техническими снимками выпуска
 * release-snapshot/release-snapshot-entry (dataVersion 1); кодеки в workspaceStorageRegistry.
 */
export const PROFILE_2: DataModelProfile = Object.freeze({
  ...base,
  version: 2,
  owners: Object.freeze({
    ...PROFILE_1.owners,
    "plan-stage": 2,
    "release-snapshot": 1,
    "release-snapshot-entry": 1,
  }),
});

/**
 * Целевой профиль: документ библиотеки dataVersion 2 — формат материала (`documentFormat`),
 * внешний адрес `url` и теги `tags`; переход `document-v1-to-v2` записывает прежним
 * документам `markdown` и `[]`. Остальные владельцы совпадают с профилем 2.
 */
export const PROFILE_3: DataModelProfile = Object.freeze({
  ...base,
  version: 3,
  owners: Object.freeze({
    ...PROFILE_2.owners,
    document: 2,
  }),
});

/** Поддерживаемые профили по возрастанию; последний — текущий. */
export const DATA_MODEL_PROFILES: readonly DataModelProfile[] = Object.freeze([
  PROFILE_1,
  PROFILE_2,
  PROFILE_3,
]);
export const CURRENT_DATA_MODEL = 3;
/** Профиль, который распознаётся по отсутствию поля dataModelVersion в manifest формата 4. */
export const UNMARKED_DATA_MODEL = 1;

export function currentProfile(
  profiles: readonly DataModelProfile[] = DATA_MODEL_PROFILES,
): DataModelProfile {
  return profiles[profiles.length - 1]!;
}

export function findProfile(
  version: number,
  profiles: readonly DataModelProfile[] = DATA_MODEL_PROFILES,
): DataModelProfile | undefined {
  return profiles.find((profile) => profile.version === version);
}
