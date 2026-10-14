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
import {
  diagnosticRecovery,
  unwrapServerDetails,
  type RecoveryContext,
} from "./presentation/recovery.js";

export interface OutputOptions {
  format: OutputFormat;
  /** Совместимость старых адаптеров; CLI больше не ограничивает размер вывода. */
  maxBytes?: number;
  text?: TextOptions;
  /** Вызов обслуживания с явными параметрами выбора базы; подсказки Core в JSON не меняются. */
  maintenanceCommand?: string;
  recovery?: RecoveryContext;
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
  hasRecovery = false,
): string {
  const serverDetails = unwrapServerDetails(details);
  if (isRecord(details) && serverDetails !== details) {
    const transport = { ...details };
    delete transport.serverDetails;
    return [
      ...(serverDetails === undefined
        ? []
        : [errorDetailsText(serverDetails, options, code, maintenanceCommand, hasRecovery)]),
      errorDetailsText(transport, options),
    ].join("\n\n");
  }
  if (code === "VALIDATION_FAILED" && Array.isArray(details)) {
    return [
      `Причин: ${details.length}`,
      ...details.map((issue, index) => {
        if (!isRecord(issue) || typeof issue.code !== "string" || typeof issue.message !== "string")
          return wrap(diagnosticValueText(issue), options.width);
        const checks = Array.isArray(issue.checks)
          ? issue.checks.filter((check) => typeof check === "string")
          : [];
        return [
          wrap(`${index + 1}. ${safeText(issue.code)} — ${safeText(issue.message)}`, options.width),
          ...(checks.length ? [`Проверок: ${checks.length}`] : []),
          ...(issue.details === undefined
            ? []
            : [
                errorDetailsText(
                  issue.details,
                  options,
                  issue.code,
                  maintenanceCommand,
                  hasRecovery,
                ),
              ]),
        ].join("\n");
      }),
    ].join("\n\n");
  }
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
      url: "URL сервера",
      reason: "Причина",
      cause: "Причина",
      owner: "Владелец",
      id: "ID",
      slot: "Группа отношений",
    };
    const fields: OutputField[] = [];
    const steps: string[] = [];
    const issues: string[] = [];
    const rest: [string, unknown][] = [];
    for (const [name, value] of Object.entries(details)) {
      // Машинная причина хранилища повторяет заголовок ошибки.
      if (name === "code" && value === code) continue;
      if (["hint", "recovery", "nextCommand", "next"].includes(name) && typeof value === "string") {
        if (!value.trim()) continue;
        if (
          hasRecovery &&
          [
            "STORAGE_INDEX_STALE",
            "STORAGE_INDEX_CORRUPT",
            "INVALID_DATA",
            "STORAGE_DATA_CORRUPT",
            "STORAGE_REFERENCE_BROKEN",
            "RELATION_MANAGED",
            "MANAGED_RELATIONS_MISMATCH",
          ].includes(code ?? "")
        )
          continue;
        const match = /^(?:Синтаксис и примеры: )?(npx @oim-dev\/relay-cli(?:[\s].*)?)$/s.exec(
          value,
        );
        steps.push(
          match
            ? commandText(localizeStorageCommand(match[1]!, maintenanceCommand), options)
            : storageNextText(value, options.width, maintenanceCommand),
        );
      } else if (name === "issues" && Array.isArray(value)) {
        issues.push(...value.map((issue) => schemaIssueText(issue, options)));
      } else if (
        code === "MANAGED_RELATIONS_MISMATCH" &&
        ["missing", "extra", "drift"].includes(name) &&
        Array.isArray(value)
      ) {
        fields.push([
          { missing: "Недостающих", extra: "Лишних", drift: "Изменённых пояснений" }[name]!,
          value.length,
        ]);
      } else if (Object.hasOwn(labels, name)) {
        fields.push([
          labels[name]!,
          name === "path" || name === "field"
            ? diagnosticPath(value)
            : ["ref", "owner"].includes(name) && referenceText(value)
              ? referenceText(value)!
              : typeof value === "string" && value !== "" && !["expected", "actual"].includes(name)
                ? safeText(value)
                : diagnosticValueText(value),
          ...(["path", "field", "ref", "id", "owner", "requestId", "url"].includes(name)
            ? (["opaque"] as const)
            : ([] as const)),
        ]);
      } else {
        rest.push([name, value]);
      }
    }
    return [
      cardText({ title: "", fields }, options),
      ...issues,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function referenceText(value: unknown): string | undefined {
  return isRecord(value) && typeof value.kind === "string" && typeof value.id === "string"
    ? `${safeText(value.kind)}:${safeText(value.id)}`
    : undefined;
}

function schemaIssueText(issue: unknown, options: TextOptions): string {
  if (!isRecord(issue) || !Array.isArray(issue.path) || typeof issue.message !== "string")
    return wrap(diagnosticValueText(issue), options.width);
  const fields: OutputField[] = [];
  if (issue.path !== undefined) fields.push(["Поле", diagnosticPath(issue.path), "opaque"]);
  if (issue.expected !== undefined) fields.push(["Ожидалось", diagnosticValueText(issue.expected)]);
  if (issue.received !== undefined) fields.push(["Получено", diagnosticValueText(issue.received)]);
  return cardText(
    {
      title: issue.code === "invalid_type" ? "Неверный тип значения" : issue.message,
      fields,
    },
    options,
  );
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
  if (error.code === "CONFLICTING_OPTIONS" || error.code === "STDIN_ALREADY_USED") {
    return "Выберите один источник каждого поля и не более одного потребителя stdin (-) во всей команде. Уберите несовместимые параметры; синтаксис и примеры доступны через --help у этой команды.";
  }
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
  const recovery =
    options.format === "text" && !(error instanceof PresentedError)
      ? diagnosticRecovery(error, text, options.recovery)
      : undefined;
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
                    !!recovery,
                  ),
                ]),
            ...(recovery
              ? ["", recovery]
              : recoveryText(error)
                ? ["", wrap(`Следующий шаг: ${recoveryText(error)}`, text.width)]
                : []),
            "",
          ].join("\n");
  stream.write(encode());
}
