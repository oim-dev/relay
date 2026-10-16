import { safeText } from "./safe.js";
import { palette, defaultTextOptions } from "./theme.js";
import type { TextOptions } from "./theme.js";
import { pad, wrap } from "./layout.js";
import stringWidth from "string-width";

export type OutputField = readonly [
  label: string,
  value: string | number | null | undefined,
  mode?: "opaque",
];
export interface OutputSection {
  title: string;
  body: string;
}
export interface OutputCommand {
  label: string;
  command: string;
  /** Навигационные команды без назначения остаются метаданными, а не подсказками text. */
  purpose?: "continuation" | "recovery" | "confirmation";
}

function outputWidth(options: TextOptions): number {
  return Number.isFinite(options.width)
    ? Math.max(24, Math.min(160, Math.floor(options.width)))
    : 100;
}

/** Опциональный адрес заголовка копируется целиком; название переносится независимо. */
function headingText(title: string, options: TextOptions, opaqueKey?: string): string {
  return [
    opaqueKey === undefined
      ? ""
      : safeText(opaqueKey).replaceAll("\n", "\\n").replaceAll("\r", "\\r"),
    wrap(safeText(title), outputWidth(options)),
  ]
    .filter(Boolean)
    .join("\n");
}

function metadata(fields: readonly OutputField[], options: TextOptions): string {
  const present = fields.filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
  const width = outputWidth(options);
  const labels = present.map(([label]) => safeText(label));
  const labelWidth = Math.max(0, ...labels.map((label) => stringWidth(label)));
  return present
    .map(([, value, mode], index) => {
      const label = labels[index]!;
      const text = safeText(String(value));
      // Адреса и версии копируются буквально: переносим метку, но не сам токен.
      if (mode === "opaque") {
        const token = text.replaceAll("\n", "\\n").replaceAll("\r", "\\r");
        const prefix = pad(label + ":", labelWidth + 1) + " ";
        return label.includes("\n") || stringWidth(prefix + token) > width
          ? `${wrap(label + ":", width)}\n  ${token}`
          : prefix + token;
      }
      if (labelWidth > Math.floor(width / 2) || label.includes("\n")) {
        return `${wrap(label + ":", width)}\n${wrap(text, width - 2)
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n")}`;
      }
      const prefix = pad(label + ":", labelWidth + 1) + " ";
      return (
        prefix +
        wrap(text, width - labelWidth - 2).replaceAll("\n", "\n" + " ".repeat(labelWidth + 2))
      );
    })
    .join("\n");
}

function commandsText(commands: readonly OutputCommand[], options: TextOptions): string {
  return commands
    .filter(({ command, purpose }) => purpose !== undefined && command.trim())
    .map(
      ({ label, command }) =>
        `${wrap(safeText(label), outputWidth(options))}\n${commandText(command, options)}`,
    )
    .join("\n\n");
}

/** Граница оформления, не машинный разделитель: пользовательский текст остаётся буквальным. */
export function actionsText(commands: readonly OutputCommand[], options: TextOptions): string {
  const body = commandsText(commands, options);
  return body
    ? `───\n${wrap("Команды CLI — вне содержания", outputWidth(options))}\n\n${body}`
    : "";
}

/** Поля выбирает предметный владелец; body секций уже подготовлен его рендерером. */
export function cardText(
  input: {
    title: string;
    opaqueKey?: string;
    fields?: readonly OutputField[];
    sections?: readonly OutputSection[];
    commands?: readonly OutputCommand[];
  },
  options: TextOptions,
): string {
  return [
    headingText(input.title, options, input.opaqueKey),
    metadata(input.fields ?? [], options),
    ...(input.sections ?? [])
      .filter(({ body }) => body.trim())
      .map(({ title, body }) => `${wrap(safeText(title), outputWidth(options))}\n${body}`),
    input.sections?.some(({ body }) => body.trim())
      ? actionsText(input.commands ?? [], options)
      : commandsText(input.commands ?? [], options),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function listText(
  input: {
    title: string;
    filters?: readonly OutputField[];
    items: readonly {
      key: string;
      keyMode?: "opaque";
      title: string;
      details?: readonly string[];
      fields?: readonly OutputField[];
    }[];
    emptyMessage?: string;
    commands?: readonly OutputCommand[];
  },
  options: TextOptions,
): string {
  const width = outputWidth(options);
  return [
    wrap(safeText(input.title), width),
    metadata(input.filters ?? [], options),
    input.items.length
      ? input.items
          .map(({ key, keyMode, title, details, fields }) =>
            [
              keyMode === "opaque"
                ? headingText(title, options, key)
                : wrap(safeText([key, title].filter(Boolean).join(" — ")), width),
              ...(details ?? [])
                .filter((detail) => detail.trim())
                .map((detail) =>
                  wrap(safeText(detail), width - 2)
                    .split("\n")
                    .map((line) => `  ${line}`)
                    .join("\n"),
                ),
              ...(fields?.length ? [metadata(fields, options)] : []),
            ].join("\n"),
          )
          .join("\n\n")
      : emptyText(input.emptyMessage, { ...options, width }),
    actionsText(input.commands ?? [], options),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function receiptText(
  input: {
    title: string;
    fields?: readonly OutputField[];
    commands?: readonly OutputCommand[];
  },
  options: TextOptions,
): string {
  return cardText(input, options);
}

/** Команда копируется целиком: физические переносы по ширине здесь запрещены. */
export function commandText(command: string, options: TextOptions = defaultTextOptions): string {
  return palette(options).cyan(safeText(command));
}

export function emptyText(
  message = "Ничего не найдено",
  options: TextOptions = defaultTextOptions,
): string {
  return palette(options).dim(wrap(safeText(message), options.width));
}
