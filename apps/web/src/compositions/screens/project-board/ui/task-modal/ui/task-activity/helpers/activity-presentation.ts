import type { ActivitySummary } from "domains/board-tasks";

/** Записи одного календарного дня в часовом поясе пользователя. */
type ActivityDay = {
  /** Стабильный ключ группы. */
  key: string;
  /** Читаемая дата. */
  label: string;
  /** Записи в исходном порядке. */
  entries: ActivitySummary[];
};

/** Текстовые подписи записи для визуального представления. */
type ActivityEntryPresentation = {
  /** Роль без повторения имени. */
  role: string;
  /** Время с точностью до секунды. */
  time: string;
  /** Полная дата для доступного имени и подсказки. */
  timestamp: string;
};

/**
 * Группирует последовательные страницы, не меняя порядок или границы их записей.
 */
export const groupActivityDays = (entries: ActivitySummary[]): ActivityDay[] => {
  const groups: ActivityDay[] = [];
  let previousDay = "";
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  for (const entry of entries) {
    const date = new Date(entry.at);
    const key = date.toDateString();
    const existing = groups.at(-1);
    if (existing && previousDay === key) {
      existing.entries.push(entry);
      continue;
    }
    const formatted = date.toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long",
      ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
    });
    const label =
      key === today.toDateString()
        ? `Сегодня, ${formatted}`
        : key === yesterday.toDateString()
          ? `Вчера, ${formatted}`
          : formatted;
    groups.push({ key: `${key}:${entry.id}`, label, entries: [entry] });
    previousDay = key;
  }
  return groups;
};

/**
 * Подготавливает компактную подпись автора и точное время без технических идентификаторов.
 */
export const describeActivityEntry = (entry: ActivitySummary): ActivityEntryPresentation => {
  const date = new Date(entry.at);
  const role =
    entry.actorRole === "orchestrator"
      ? "Оркестратор"
      : entry.actorRole === "worker"
        ? "Воркер"
        : entry.actorRole === "operator"
          ? "Оператор"
          : "";
  return {
    role: role === entry.actor ? "" : role,
    time: date.toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
    timestamp: date.toLocaleString("ru-RU", { dateStyle: "full", timeStyle: "medium" }),
  };
};
