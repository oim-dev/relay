import pc from "picocolors";
import { defaultConfig } from "@relay/core/domain/config";
import type { Config } from "@relay/core/domain/config";
import { safeText } from "./safe.js";

export interface TextOptions {
  /** Совместимость старых рендереров; значение не включает цвет. */
  color: boolean;
  width: number;
}

export const defaultTextOptions: TextOptions = { color: false, width: 100 };

/** Старые рендереры сохраняют вызовы стилей, но ни один стиль не генерирует ANSI. */
export function palette(_options: TextOptions = defaultTextOptions) {
  const plain = pc.createColors(false);
  return Object.fromEntries(
    Object.entries(plain).map(([name, value]) => [
      name,
      typeof value === "function" ? (text: unknown) => safeText(String(text)) : value,
    ]),
  ) as typeof plain;
}

export function statusText(
  status: string,
  _options: TextOptions,
  config: Config = defaultConfig,
  blocked = false,
): string {
  const rule = config.statuses[status];
  const label = rule?.satisfiesDependencies
    ? `✓ ${status === "done" ? "Выполнена" : safeText(status)}`
    : rule?.terminal
      ? `− ${status === "cancelled" ? "Отменена" : safeText(status)}`
      : status === "in_progress"
        ? "● В работе"
        : status === "review"
          ? "◇ На проверке"
          : `○ ${status === "todo" ? (blocked ? "Ожидает" : "К работе") : safeText(status)}`;
  return label;
}

export function taskReference(task: { id: number }): string {
  return `#${task.id}`;
}

export function dateText(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
