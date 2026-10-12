import type { Writable } from "node:stream";
import { AppError } from "@relay/core/shared/errors";
import type { Result, OutputFormat } from "./queries/result.js";
import { serializeResult } from "./queries/result.js";
import { defaultTextOptions, palette } from "./presentation/theme.js";
import type { TextOptions } from "./presentation/theme.js";
import { safeText, diagnosticValueText } from "./presentation/text.js";
import { wrap } from "./presentation/layout.js";
import { safeJson } from "./presentation/safe.js";
import { cardText, commandText } from "./presentation/common.js";
import { localizeStorageCommand, storageNextText } from "./presentation/storage.js";
import type { OutputField } from "./presentation/common.js";

export interface OutputOptions {
  format: OutputFormat;
  /** Совместимость старых адаптеров; CLI больше не ограничивает размер вывода. */
  maxBytes?: number;
  text?: TextOptions;
  /** Вызов обслуживания с фактическим config для подсказок Core; JSON не меняется. */
  maintenanceCommand?: string;
}

/**
 * Ошибка с собственным human-представлением (например, отчёт storage status с ненулевым
 * exit). JSON остаётся общим конвертом ошибки с машинными details.
 */
export class PresentedError extends AppError {
  constructor(
    code: string,
    message: string,
    exitCode: number,
    details: unknown,
    readonly text: (options: TextOptions) => string,
  ) {
    super(code, message, exitCode, details);
  }
}

export function printResult(stream: Writable, result: Result, options: OutputOptions): void {
  const encoded = serializeResult(result, options.format, options.text);
  stream.write(encoded);
}

/** Машинный details не меняется; готовая help-команда в text не переносится по ширине. */
function errorDetailsText(
  details: unknown,
  options: TextOptions,
  code?: string,
  maintenanceCommand?: string,
): string {
  if (details !== null && typeof details === "object" && !Array.isArray(details)) {
    const labels: Record<string, string> = {
      field: "Поле",
      path: "Путь",
      expected: "Ожидалось",
      current: "Фактически",
      actual: "Получено",
      expectedRevision: "Ожидаемая ревизия",
      actualRevision: "Текущая ревизия",
      ref: "Запись",
      requestId: "ID запроса",
      reason: "Причина",
      cause: "Причина",
    };
    const fields: OutputField[] = [];
    const steps: string[] = [];
    const rest: [string, unknown][] = [];
    for (const [name, value] of Object.entries(details)) {
      // Машинная причина хранилища повторяет заголовок ошибки.
      if (name === "code" && value === code) continue;
      if (["hint", "recovery", "nextCommand", "next"].includes(name) && typeof value === "string") {
        if (!value.trim()) continue;
        const match = /^(?:Синтаксис и примеры: )?(npx @oim-dev\/relay-cli(?:[\s].*)?)$/s.exec(
          value,
        );
        steps.push(
          match
            ? commandText(localizeStorageCommand(match[1]!, maintenanceCommand), options)
            : storageNextText(value, options.width, maintenanceCommand),
        );
      } else if (Object.hasOwn(labels, name)) {
        fields.push([
          labels[name]!,
          name === "path"
            ? diagnosticPath(value)
            : typeof value === "string" && value !== "" && !["expected", "actual"].includes(name)
              ? safeText(value)
              : diagnosticValueText(value),
        ]);
      } else {
        rest.push([name, value]);
      }
    }
    return [
      cardText({ title: "", fields }, options),
      ...(rest.length
        ? [`Подробности:\n${wrap(diagnosticValueText(Object.fromEntries(rest)), options.width)}`]
        : []),
      ...(steps.length ? [`Следующий шаг:\n${steps.join("\n\n")}`] : []),
      ...(Object.keys(details).length === 0 ? ["{}"] : []),
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  return wrap(diagnosticValueText(details), options.width);
}

function diagnosticPath(value: unknown): string {
  if (
    Array.isArray(value) &&
    value.length &&
    value.every(
      (part) =>
        typeof part === "string" ||
        (typeof part === "number" && Number.isInteger(part) && part >= 0),
    )
  ) {
    return value
      .map((part, index) =>
        typeof part === "number"
          ? `[${part}]`
          : /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(part)
            ? `${index ? "." : ""}${safeText(part)}`
            : `[${diagnosticValueText(part)}]`,
      )
      .join("");
  }
  return typeof value === "string" && value ? safeText(value) : diagnosticValueText(value);
}

function recoveryText(error: AppError): string {
  const details = error.details;
  if (
    details &&
    typeof details === "object" &&
    !Array.isArray(details) &&
    Object.entries(details).some(
      ([key, value]) =>
        ["hint", "recovery", "nextCommand", "next"].includes(key) &&
        typeof value === "string" &&
        value.trim(),
    )
  )
    return "";
  if (/CONFLICT|REVISION|VERSION|STALE/.test(error.code)) {
    return "Перечитайте запись или начните список с первой страницы. Сравните изменения перед новой попыткой; не подставляйте свежую ревизию автоматически.";
  }
  if (/INVALID|VALIDATION|ARGUMENT|UNKNOWN_METRIC/.test(error.code)) {
    return "Проверьте указанные поля и параметры. Синтаксис и примеры доступны через --help у этой команды.";
  }
  if (/NOT_FOUND/.test(error.code)) {
    return "Проверьте ключ записи и выбранный проект; найдите запись в соответствующем списке.";
  }
  return "Проверьте параметры и подключение. Если ошибка возникла при записи, сначала перечитайте состояние: повтор может выполнить действие ещё раз.";
}

export function printError(stream: Writable, error: AppError, options: OutputOptions): void {
  const payload = {
    ok: false,
    error: { code: error.code, message: error.message, details: error.details },
  };
  const text = { ...(options.text ?? defaultTextOptions), color: false };
  const colors = palette(text);
  const encode = () =>
    options.format === "json"
      ? `${safeJson(payload)}\n`
      : error instanceof PresentedError
        ? [colors.bold(`Ошибка: ${safeText(error.code)}`), safeText(error.text(text)), ""].join(
            "\n",
          )
        : [
            colors.red(colors.bold(`Ошибка: ${safeText(payload.error.code)}`)),
            wrap(safeText(payload.error.message), text.width),
            ...(payload.error.details === undefined
              ? []
              : [
                  "",
                  errorDetailsText(
                    payload.error.details,
                    text,
                    payload.error.code,
                    options.maintenanceCommand,
                  ),
                ]),
            ...(recoveryText(error)
              ? ["", wrap(`Следующий шаг: ${recoveryText(error)}`, text.width)]
              : []),
            "",
          ].join("\n");
  stream.write(encode());
}
