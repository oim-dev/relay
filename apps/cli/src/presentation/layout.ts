import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { palette } from "./theme.js";
import type { TextOptions } from "./theme.js";
import { safeText } from "./safe.js";

const plain = (text: string) => safeText(text);

export function wrap(text: string, width: number): string {
  return wrapAnsi(plain(text), Math.max(1, width), { hard: true, trim: false, wordWrap: true });
}

export function pad(text: string, width: number): string {
  const value = plain(text);
  return value + " ".repeat(Math.max(0, width - stringWidth(value)));
}

/** Ширина считается в ячейках терминала: ANSI, emoji и широкие символы не сдвигают колонки. */
export function table(
  headers: string[],
  rows: string[][],
  widths: number[],
  options: TextOptions,
): string {
  const colors = palette(options);
  const render = (cells: string[]) => {
    const lines = cells.map((cell, index) => wrap(cell, widths[index]!).split("\n"));
    return Array.from({ length: Math.max(...lines.map((column) => column.length)) }, (_, row) =>
      lines
        .map((column, index) => pad(column[row] ?? "", widths[index]!))
        .join("  ")
        .trimEnd(),
    ).join("\n");
  };
  return [
    colors.bold(render(headers.map(plain))),
    colors.dim(widths.map((width) => "─".repeat(width)).join("  ")),
    ...rows.map((row) => render(row.map(plain))),
  ].join("\n");
}

export function frame(title: string, lines: string[], options: TextOptions): string {
  return [
    wrap(plain(title), options.width),
    ...lines.map((line) => wrap(line, options.width)),
  ].join("\n");
}

export function section(title: string, body: string, options: TextOptions): string {
  if (!body.trim()) return "";
  return `${wrap(plain(title), options.width)}\n${body}`;
}
