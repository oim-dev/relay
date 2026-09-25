import { createHash, randomInt } from "node:crypto";
import { basename, dirname } from "node:path";
import type { Config } from "../domain/config.js";
import type { ProjectSettings } from "../domain/project-settings.js";

/**
 * Получает исходное отображаемое имя из каталога проекта.
 */
export function defaultProjectName(configPath: string): string {
  const directory = dirname(configPath);
  return (
    basename(basename(directory) === ".relay" ? dirname(directory) : directory)
      .replace(/\p{Cc}/gu, " ")
      .trim() || "Проект"
  ).slice(0, 120);
}

/**
 * Выделяет начальный адрес из четырёх случайных букв и цифр.
 */
export function createProjectSlug(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `project-${Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("")}`;
}

/**
 * Читает настройки старой конфигурации без записи и без смены адреса между запросами.
 */
export function projectSettings(config: Config, configPath: string): ProjectSettings {
  if (config.projectSettings) {
    const { name, slug, revision, documentSections } = config.projectSettings;
    return {
      name,
      slug,
      revision,
      ...(documentSections === undefined ? {} : { documentSections }),
    };
  }
  const suffix = createHash("sha256")
    .update(config.projectId ?? configPath)
    .digest("hex")
    .slice(0, 4);
  return { name: defaultProjectName(configPath), slug: `project-${suffix}`, revision: 0 };
}
