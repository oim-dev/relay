import type {
  StorageBlocker,
  StorageMigrationStep,
  StorageStatusKind,
} from "@relay/contracts/storage-maintenance";
import { storageError } from "../errors.js";
import type { TransitionRegistry } from "../registry.js";
import { transitionOwners } from "../registry.js";
import type { SourceDiagnosis, SourceSteps, StorageSource } from "../source/reader.js";
import type { TransitionDefinition } from "../types.js";
import { planFingerprint } from "./fingerprint.js";

/**
 * Planner: упорядоченные шаги источника (физический перенос раскладки, затем предметные
 * переходы в порядке реестра) и отпечаток плана. Порядок предметных шагов строит реестр
 * (`TransitionRegistry.plan`); planner не ветвится по видам, версиям и semver.
 */

export type MigrationPlan = {
  /** Шаги в порядке исполнения; пусто — нет преобразований (возможен только маркер профиля). */
  readonly steps: readonly TransitionDefinition[];
  /** Профиль manifest ниже целевого или раскладка до формата 4. */
  readonly marker: boolean;
  /** Шаг маркера профиля формата 4 (profile.<из>-to-<в>); null — профиль не меняется отдельно. */
  readonly profileStep: ProfileStep | null;
  /** Все шаги плана `id`/`version` в порядке исполнения (вход отпечатка и WAL). */
  readonly refs: readonly { id: string; version: number }[];
  readonly fingerprint: string;
};

export type ProfileStep = {
  readonly id: string;
  readonly version: 1;
  readonly from: number;
  readonly to: number;
};

const PROFILE_REF = /^profile\.([1-9][0-9]*)-to-([1-9][0-9]*)$/;
export const isProfileStepId = (id: string) => PROFILE_REF.test(id);

/** Явный шаг маркера: базы формата 4 с профилем ниже целевого. */
export function profileStepOf(
  source: StorageSource,
  registry: TransitionRegistry,
): ProfileStep | null {
  const to = registry.profile.version;
  if (source.profile === null || source.profile >= to) return null;
  return { id: `profile.${source.profile}-to-${to}`, version: 1, from: source.profile, to };
}

const MAX_BLOCKERS = 50;
const UNSUPPORTED = new Set<StorageBlocker["code"]>([
  "STORAGE_VERSION_UNSUPPORTED",
  "STORAGE_TRANSITION_MISSING",
  "UNKNOWN_ENTITY_KIND",
  "STORAGE_FORMAT_UNKNOWN",
]);

export function orderedSteps(steps: SourceSteps | null): TransitionDefinition[] {
  if (!steps) return [];
  return [...(steps.physical ? [steps.physical] : []), ...steps.data];
}

export const stepRef = (step: { id: string; version: number }) => `${step.id}@${step.version}`;

/** Отпечаток плана по источнику и шагам; без шагов — отпечаток текущего состава. */
export function fingerprintOf(
  source: StorageSource,
  registry: TransitionRegistry,
  steps: readonly { id: string; version: number }[],
): string {
  return planFingerprint(
    source,
    registry,
    steps.map((step) => ({ id: step.id, version: step.version })),
  );
}

/** План применимого источника (status current или migration-required). */
export function planMigration(
  source: StorageSource,
  diagnosis: SourceDiagnosis,
  registry: TransitionRegistry,
): MigrationPlan {
  const steps = orderedSteps(diagnosis.steps);
  const profileStep = diagnosis.steps ? profileStepOf(source, registry) : null;
  const refs = [
    ...steps.map((step) => ({ id: step.id, version: step.version })),
    ...(profileStep ? [{ id: profileStep.id, version: profileStep.version }] : []),
  ];
  return {
    steps,
    marker: diagnosis.steps?.marker ?? false,
    profileStep,
    refs,
    fingerprint: fingerprintOf(source, registry, refs),
  };
}

/** Статус по коду блокера (как диагностика §5.3): unsupported или invalid. */
export function statusOfBlockers(blockers: readonly StorageBlocker[]): StorageStatusKind {
  return blockers.some((blocker) => UNSUPPORTED.has(blocker.code)) ? "unsupported" : "invalid";
}

/**
 * Ошибка неприменимого плана: код и details первого блокера, полный список (≤50) в details.
 * Статус recovery-required даёт STORAGE_RECOVERY_REQUIRED с путём WAL.
 */
export function planError(diagnosis: SourceDiagnosis) {
  const status = diagnosis.status;
  if (status.status === "recovery-required" && status.pending)
    return storageError(
      "STORAGE_RECOVERY_REQUIRED",
      "Есть незавершённая транзакция хранилища; миграция не начата",
      {
        reason: status.pending.kind,
        path: status.pending.path,
      },
    );
  const first = diagnosis.blockers[0];
  if (!first)
    return storageError("STORAGE_FORMAT_UNKNOWN", "Состояние хранилища не распознано", {
      reason: status.status,
    });
  return storageError(
    first.code,
    `Миграция неприменима: найдено блокеров — ${diagnosis.blockers.length}. ${first.message}`.slice(
      0,
      1024,
    ),
    {
      reason: status.status,
      ...(first.owner ? { owner: first.owner } : {}),
      ...(first.step ? { step: first.step } : {}),
      ...(first.path ? { path: first.path } : {}),
      ...(first.id ? { id: first.id } : {}),
      ...(first.current !== undefined ? { current: first.current } : {}),
      ...(first.expected !== undefined ? { expected: first.expected } : {}),
      blockers: diagnosis.blockers.slice(0, MAX_BLOCKERS),
      next: first.next,
    },
  );
}

export type StepCounts = { checked: number; changed: number; removed: number };

/** Описание шага для плана и результата. */
export function describeStep(
  step: TransitionDefinition,
  counts: StepCounts,
  owners?: readonly string[],
): StorageMigrationStep {
  return {
    id: step.id,
    version: step.version,
    type: step.type,
    owners: [...(owners ?? (step.type === "physical" ? [] : transitionOwners(step)))].sort(),
    records: { ...counts },
  };
}

/** Шаг из записи WAL `id@version` (продолжение миграции); неизвестный — ошибка версии. */
export function stepFromRef(
  ref: string,
  registry: TransitionRegistry,
): TransitionDefinition | null {
  const at = ref.lastIndexOf("@");
  const id = ref.slice(0, at);
  const version = Number(ref.slice(at + 1));
  const profile = PROFILE_REF.exec(id);
  if (profile && version === 1 && Number(profile[2]) <= registry.profile.version) return null;
  const definition =
    registry.transition(id) ??
    (["legacy", "unified-1", "unified-2", "unified-3"] as const)
      .map((layout) => registry.physicalFrom(layout))
      .find((entry) => entry?.id === id);
  if (!definition || definition.version !== version)
    throw storageError(
      "STORAGE_VERSION_UNSUPPORTED",
      "Незавершённая миграция использует неизвестный переход; продолжение запрещено",
      { reason: "wal-transition", id: ref.slice(0, 256) },
    );
  return definition;
}
