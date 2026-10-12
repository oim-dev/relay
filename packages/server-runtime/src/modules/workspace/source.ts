import { realpath } from "node:fs/promises";
import { configSchema } from "@relay/core/domain/config";
import { parse } from "@relay/core/domain/validation";
import { AppError } from "@relay/core/shared/errors";
import { readJson } from "@relay/core/storage/files";
import { locateConfiguration, readConfiguration } from "@relay/project-runtime/config";
import type { Configuration } from "@relay/project-runtime/config";
import { isStorageCompatibility } from "@relay/project-runtime/storage-errors";

function storageIncompatible(error: unknown): error is AppError {
  return error instanceof AppError && isStorageCompatibility(error.code, error.exitCode);
}

/**
 * Local-режим на несовместимой базе: сервер стартует без миграции, recovery и записи,
 * а каждый проектный запрос получает 409 с кодом Core. После внешнего `storage migrate`
 * проект становится доступен без перезапуска. Нужна только текущая схема конфигурации
 * для порта; повреждённая конфигурация и ошибка реестра по-прежнему останавливают запуск.
 */
export async function serverConfiguration(cwd: string, explicit?: string): Promise<Configuration> {
  try {
    return await readConfiguration(cwd, explicit);
  } catch (error) {
    if (!storageIncompatible(error)) throw error;
    try {
      const path = await realpath(await locateConfiguration(cwd, explicit));
      const value = await readJson(path);
      if (typeof value === "object" && value !== null && Object.hasOwn(value, "projects"))
        throw error;
      return { kind: "project", path, value: parse(configSchema, value, path) };
    } catch {
      throw error;
    }
  }
}
