import { z } from "zod";
import { ApiError, getProjectApi, getStorageFailureMessage } from "infra/tasks-api";

/** Подтверждённые сервером имя, адрес и версия настроек. */
export const PROJECT_SETTINGS_SCHEMA = z.object({
  name: z.string(),
  slug: z.string(),
  revision: z.number().int().nonnegative(),
});
/** Настройки текущего проекта. */
export type ProjectSettings = z.infer<typeof PROJECT_SETTINGS_SCHEMA>;
/** Пара настроек и исходная ревизия редактирования. */
export type SaveProjectSettingsInput = {
  /** Однострочное отображаемое имя. */
  name: string;
  /** Человекочитаемый сегмент адреса. */
  slug: string;
  /** Подтверждённая исходная ревизия. */
  ifRevision: number;
};
const FAILURE_SCHEMA = z.object({ error: z.object({ code: z.string() }) });

/**
 * Представляет ожидаемый отказ сохранения без раскрытия транспортных деталей.
 */
export class ProjectSettingsError extends Error {
  /**
   * Сохраняет код предметного отказа для выбора действия в форме.
   */
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/**
 * Загружает настройки конкретного проекта через существующий SDK.
 */
export const getProjectSettings = async (projectId: string): Promise<ProjectSettings> =>
  PROJECT_SETTINGS_SCHEMA.parse((await getProjectApi(projectId).context.getProjectSettings()).data);

/**
 * Сохраняет настройки и переводит ожидаемые ошибки в предметный контракт.
 */
export const saveProjectSettings = async (
  projectId: string,
  input: SaveProjectSettingsInput,
): Promise<ProjectSettings> => {
  try {
    return PROJECT_SETTINGS_SCHEMA.parse(
      (await getProjectApi(projectId).context.saveProjectSettings(input)).data,
    );
  } catch (error) {
    if (error instanceof ApiError) {
      const failure = FAILURE_SCHEMA.safeParse(error.error);
      const code = failure.success ? failure.data.error.code : "UNAVAILABLE";
      if (code === "PROJECT_SLUG_TAKEN")
        throw new ProjectSettingsError("Этот адрес уже занят. Попробуйте другой slug.", code);
      if (code === "REVISION_CONFLICT")
        throw new ProjectSettingsError(
          "Настройки изменились в другом окне. Ваш ввод сохранён.",
          code,
        );
      const storageMessage = getStorageFailureMessage(error);
      if (storageMessage !== null) throw new ProjectSettingsError(storageMessage, code);
      if (code === "VALIDATION_ERROR")
        throw new ProjectSettingsError("Проверьте имя и формат slug.", code);
      throw new ProjectSettingsError(
        "Сервер не подтвердил сохранение. Ваш ввод сохранён — попробуйте ещё раз.",
        "UNAVAILABLE",
      );
    }
    if (
      error instanceof TypeError ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      throw new ProjectSettingsError(
        "Не удалось связаться с сервером. Ваш ввод сохранён — попробуйте ещё раз.",
        "UNAVAILABLE",
      );
    }
    throw error;
  }
};
