import { join } from "node:path";
import { storageManifestSchema } from "@relay/contracts/storage";
import type { z } from "zod";
import { readJson } from "../files.js";
import { AppError } from "../../shared/errors.js";
import { storageError } from "./errors.js";
import { CURRENT_DATA_MODEL, UNMARKED_DATA_MODEL } from "./profiles.js";

export type StorageManifest = z.output<typeof storageManifestSchema>;
export const MANIFEST_PATH = "storage.json";
export const CURRENT_PHYSICAL_FORMAT = 4;

/**
 * Разбор manifest с различимыми причинами: повреждение, неизвестный формат и версия новее
 * поддерживаемой не сводятся к ZodError. Строгость схемы сохраняется.
 */
export function parseStorageManifest(
  value: unknown,
  current: number = CURRENT_DATA_MODEL,
): StorageManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw storageError("STORAGE_DATA_CORRUPT", "Маркер хранилища не является JSON-объектом", {
      path: MANIFEST_PATH,
    });
  const raw = value as Record<string, unknown>;
  if (raw.format !== "relay-entities")
    throw storageError("STORAGE_FORMAT_UNKNOWN", "Неизвестный маркер формата хранилища", {
      path: MANIFEST_PATH,
    });
  if (
    typeof raw.schemaVersion === "number" &&
    Number.isInteger(raw.schemaVersion) &&
    raw.schemaVersion > CURRENT_PHYSICAL_FORMAT
  )
    throw storageError("STORAGE_VERSION_UNSUPPORTED", "Физический формат новее поддерживаемого", {
      reason: "physical",
      path: MANIFEST_PATH,
      current: raw.schemaVersion,
      expected: CURRENT_PHYSICAL_FORMAT,
    });
  if (
    typeof raw.dataModelVersion === "number" &&
    Number.isInteger(raw.dataModelVersion) &&
    raw.dataModelVersion > current
  )
    throw storageError(
      "STORAGE_VERSION_UNSUPPORTED",
      "Профиль модели данных новее поддерживаемого",
      {
        reason: "profile",
        path: MANIFEST_PATH,
        current: raw.dataModelVersion,
        expected: current,
      },
    );
  const parsed = storageManifestSchema.safeParse(value);
  if (!parsed.success)
    throw storageError("STORAGE_FORMAT_UNKNOWN", "Маркер хранилища имеет неизвестную структуру", {
      path: MANIFEST_PATH,
    });
  if (parsed.data.dataModelVersion !== undefined && parsed.data.schemaVersion !== 4)
    throw storageError(
      "STORAGE_FORMAT_UNKNOWN",
      "Профиль модели данных допустим только в формате 4",
      {
        path: MANIFEST_PATH,
        current: parsed.data.schemaVersion,
      },
    );
  return parsed.data;
}

/** Чтение manifest без recovery и записи; null — файла нет. */
export async function readStorageManifest(
  root: string,
  current: number = CURRENT_DATA_MODEL,
): Promise<StorageManifest | null> {
  let value: unknown;
  try {
    value = await readJson(join(root, MANIFEST_PATH));
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") return null;
    if (error instanceof AppError && error.code === "INVALID_DATA")
      throw storageError("STORAGE_DATA_CORRUPT", "Маркер хранилища: некорректный JSON или UTF-8", {
        path: MANIFEST_PATH,
      });
    throw error;
  }
  return parseStorageManifest(value, current);
}

/** Профиль manifest: null — физический формат до 4; отсутствие поля в формате 4 — профиль 1. */
export function manifestProfile(manifest: StorageManifest): number | null {
  if (manifest.schemaVersion !== CURRENT_PHYSICAL_FORMAT) return null;
  return manifest.dataModelVersion ?? UNMARKED_DATA_MODEL;
}

/**
 * Быстрая проверка обычного открытия без сканирования записей. Записи сохраняют
 * собственные проверки оболочки и dataVersion; маркер не разрешает пропустить шаг.
 */
export function requireCurrentProfile(
  manifest: StorageManifest,
  current: number = CURRENT_DATA_MODEL,
): void {
  if (manifest.schemaVersion !== CURRENT_PHYSICAL_FORMAT)
    throw storageError(
      "STORAGE_MIGRATION_REQUIRED",
      "Физический формат хранилища устарел. Требуется явная миграция",
      {
        reason: "physical",
        path: MANIFEST_PATH,
        current: manifest.schemaVersion,
        expected: CURRENT_PHYSICAL_FORMAT,
      },
    );
  const profile = manifestProfile(manifest)!;
  if (profile > current)
    throw storageError(
      "STORAGE_VERSION_UNSUPPORTED",
      "Профиль модели данных новее поддерживаемого",
      {
        reason: "profile",
        path: MANIFEST_PATH,
        current: profile,
        expected: current,
      },
    );
  if (profile < current)
    throw storageError(
      "STORAGE_MIGRATION_REQUIRED",
      "Профиль модели данных устарел. Требуется явная миграция",
      { reason: "profile", path: MANIFEST_PATH, current: profile, expected: current },
    );
}

/** Manifest, который пишут новые базы и успешная миграция. */
export function currentManifest(productId?: string): StorageManifest {
  return {
    format: "relay-entities",
    schemaVersion: CURRENT_PHYSICAL_FORMAT,
    ...(productId === undefined ? {} : { productId }),
    dataModelVersion: CURRENT_DATA_MODEL,
  };
}
