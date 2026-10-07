import { createHash } from "node:crypto";
import type { JsonValue } from "@relay/contracts/storage";
import { canonical } from "../../entity-store/format.js";
import type { TransitionRegistry } from "../registry.js";
import type { StorageSource } from "../source/reader.js";

/** Версия алгоритма отпечатка; меняется при изменении состава входа. */
export const PLAN_FINGERPRINT_ALGORITHM = 1;

export type FingerprintStep = { readonly id: string; readonly version: number };

/**
 * Файловый состав отпечатка: все постоянные объекты управляемой области (файлы — sha256,
 * каталоги — "dir") и объекты вне её (путь + sha256 или "dir"). Runtime, замки и временные
 * следы обслуживания не входят; `runtime/index-stale.json` входит.
 * Ключ — `<область>:<относительный путь>`, без абсолютных путей.
 */
export function fingerprintFiles(source: StorageSource): [string, string][] {
  return source.entries
    .filter((entry) => entry.persistent)
    .map((entry): [string, string] => [
      `${entry.area}:${entry.path}`,
      entry.type === "dir" ? "dir" : entry.type === "file" ? entry.sha256! : entry.type,
    ])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * planFingerprint: sha256 канонического JSON из версии алгоритма, digest реестра переходов,
 * исходной раскладки и профиля, целевого профиля, полного состава и содержимого источников и
 * упорядоченных шагов `id@version`. Не содержит абсолютных путей, времени и служебных UUID:
 * одинаковые данные и реестр дают одинаковый отпечаток; правка, добавление или удаление
 * файла и изменение реестра меняют его.
 */
export function planFingerprint(
  source: StorageSource,
  registry: Pick<TransitionRegistry, "digest" | "profile">,
  steps: readonly FingerprintStep[],
): string {
  const value = {
    algorithm: PLAN_FINGERPRINT_ALGORITHM,
    registryDigest: registry.digest,
    source: {
      layout: source.layout,
      physical: source.physical,
      profile: source.profile,
    },
    target: registry.profile.version,
    files: fingerprintFiles(source),
    steps: steps.map((step) => `${step.id}@${step.version}`),
  } satisfies JsonValue;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
