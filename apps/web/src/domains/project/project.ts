import { z } from "zod";
import { getProjectApi } from "infra/tasks-api";

const STATUS_SCHEMA = z.object({
  terminal: z.boolean(),
  satisfiesDependencies: z.boolean(),
  color: z.string().optional(),
});
const CONTEXT_SCHEMA = z.object({
  capabilities: z.array(z.string()).optional(),
  synchronizationMode: z.enum(["file", "git"]).optional(),
  project: z.string(),
  projectId: z.string(),
  actor: z.string(),
  configPath: z.string(),
  config: z.object({
    defaultStatus: z.string(),
    readyStatuses: z.array(z.string()),
    statuses: z.record(z.string(), STATUS_SCHEMA),
  }),
});

/** Конфигурация колонки и допустимых завершений. */
export type TaskStatus = {
  /** Непрозрачный ключ статуса. */
  id: string;
  /** Понятное имя известного статуса либо исходное имя пользователя. */
  label: string;
  /** Цветовая категория конфигурации. */
  color: string;
  /** Завершает работу над задачей. */
  isTerminal: boolean;
  /** Удовлетворяет блокирующим зависимостям. */
  isSuccessful: boolean;
};

/** Рабочий проект и автор текущего запуска сервера. */
export type Project = {
  /** Сервер предоставляет отдельный статус фоновой доставки базы. */
  hasBackgroundSynchronization: boolean;
  /** Идентификатор области данных и предпочтений. */
  id: string;
  /** Название рабочего каталога. */
  name: string;
  /** Автор изменений. */
  actor: string;
  /** Путь к конфигурации для справочной информации. */
  configPath: string;
  /** Начальный статус создаваемой задачи. */
  defaultStatus: string;
  /** Статусы, из которых можно взять задачу. */
  readyStatuses: string[];
  /** Упорядоченные колонки доски. */
  statuses: TaskStatus[];
};

const STATUS_LABELS: Record<string, string> = {
  todo: "К выполнению",
  in_progress: "В работе",
  review: "На проверке",
  done: "Готово",
  cancelled: "Отменено",
};

/**
 * Преобразует конфигурацию сервера в рабочую модель проекта.
 */
export const getProject = async (projectId: string): Promise<Project> => {
  const response = await getProjectApi(projectId).context.getContext();
  const context = CONTEXT_SCHEMA.parse(response.data);
  return {
    hasBackgroundSynchronization:
      (context.capabilities?.includes("relay-background-sync-v1") ?? false) &&
      context.synchronizationMode !== "file",
    id: context.projectId,
    name: context.project,
    actor: context.actor,
    configPath: context.configPath,
    defaultStatus: context.config.defaultStatus,
    readyStatuses: context.config.readyStatuses,
    statuses: Object.entries(context.config.statuses).map(([id, definition]) => ({
      id,
      label: STATUS_LABELS[id] ?? id,
      color: definition.color ?? "gray",
      isTerminal: definition.terminal,
      isSuccessful: definition.satisfiesDependencies,
    })),
  };
};
