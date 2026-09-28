import { toText } from "@relay/core/domain/markdown";
import { safeText, safeJson } from "./safe.js";
import { defaultTextOptions, palette } from "./theme.js";
import type { TextOptions } from "./theme.js";
import { renderMarkdown } from "./markdown.js";
import { section, wrap } from "./layout.js";
export { safeText } from "./safe.js";

export function markdownText(
  lines: readonly string[],
  options: TextOptions = defaultTextOptions,
): string {
  return renderMarkdown(toText(lines), options);
}

/** Совместимость старых списков: ширина регулирует переносы, но не полноту текста. */
export function previewText(value: string, _limit = 160): string {
  return safeText(value);
}

export function valueText(value: unknown, options: TextOptions = defaultTextOptions): string {
  const colors = palette(options);
  if (value === null || value === undefined) return colors.dim("—");
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (Array.isArray(value))
    return value.map((item) => `• ${valueText(item, options)}`).join("\n") || colors.dim("—");
  if (typeof value === "object")
    return Object.entries(value)
      .map(
        ([name, item]) =>
          `${colors.dim(safeText(name) + ":")} ${valueText(item, options).replaceAll("\n", "\n  ")}`,
      )
      .join("\n");
  return safeText(String(value));
}

/** Диагностика различает типы и пустые значения; обычные карточки сохраняют свою политику. */
export function diagnosticValueText(value: unknown): string {
  const ancestors = new Set<object>();
  const render = (item: unknown): string => {
    if (typeof item === "string") return safeJson(item);
    if (item === null) return "null";
    if (typeof item !== "object") return safeText(String(item));
    if (ancestors.has(item)) return "[циклическая ссылка]";
    ancestors.add(item);
    const result = Array.isArray(item)
      ? `[${Array.from(item, render).join(", ")}]`
      : Object.keys(item).length
        ? `{\n${Object.entries(item)
            .map(([key, entry]) => `  ${safeJson(key)}: ${render(entry).replaceAll("\n", "\n  ")}`)
            .join(",\n")}\n}`
        : "{}";
    ancestors.delete(item);
    return result;
  };
  return render(value);
}

export function fieldsText(
  fields: Record<string, unknown>,
  options: TextOptions = defaultTextOptions,
): string {
  return Object.entries(fields)
    .map(([name, value]) =>
      section(
        safeText(name),
        ["description", "summary", "body"].includes(name) && Array.isArray(value)
          ? markdownText(value as string[], options)
          : wrap(valueText(value, options), options.width),
        options,
      ),
    )
    .join("\n\n");
}
