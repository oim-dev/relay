import { synchronizationStatusSchema } from "@relay/contracts/synchronization";
import { ApiError, getProjectApi } from "infra/tasks-api";

/** Состояние доставки выбранного проекта; не состояние доступности его локальных данных. */
export type ProjectSynchronization = {
  isGit: boolean;
  state: "local" | "synced" | "pending" | "syncing" | "offline" | "conflict" | "unknown";
  queuedCommits: number | null;
  hasUncommittedChanges: boolean;
  lastSuccessAt: string | null;
  nextAttemptAt: string | null;
  origin: string | null;
  error: string | null;
};

/** Ошибка адресного чтения/запроса доставки не блокирует предметный интерфейс. */
export class ProjectSynchronizationError extends Error {}

/** Адаптирует технический статус сервера к рабочему состоянию проекта. */
const projectSynchronization = (value: unknown): ProjectSynchronization => {
  const status = synchronizationStatusSchema.parse(value);
  return {
    isGit: status.mode === "git",
    state: status.status,
    queuedCommits: status.queuedCommits,
    hasUncommittedChanges: status.uncommittedChanges,
    lastSuccessAt: status.lastSuccessAt,
    nextAttemptAt: status.nextAttemptAt,
    origin: status.origin,
    error: status.error?.message ?? null,
  };
};

/** Получает локальный статус доставки, не инициируя сетевую проверку Git. */
export const getProjectSynchronization = async (
  projectId: string,
): Promise<ProjectSynchronization> => {
  try {
    return projectSynchronization(
      (await getProjectApi(projectId).context.getSynchronizationStatus()).data,
    );
  } catch {
    throw new ProjectSynchronizationError(
      "Статус синхронизации недоступен. Публикация в origin не подтверждена.",
    );
  }
};

/** Запрашивает фоновую попытку; Server отвечает до завершения Git. */
export const requestProjectSynchronization = async (
  projectId: string,
): Promise<ProjectSynchronization> => {
  try {
    return projectSynchronization(
      (await getProjectApi(projectId).context.requestSynchronization({})).data,
    );
  } catch (error) {
    if (
      error instanceof ApiError ||
      error instanceof TypeError ||
      (error instanceof DOMException && error.name === "AbortError")
    )
      throw new ProjectSynchronizationError(
        "Не удалось подтвердить запуск синхронизации. Локальные данные сохранены.",
      );
    throw error;
  }
};
