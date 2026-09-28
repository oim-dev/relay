import { safeText } from "./safe.js";
import type { TextOptions } from "./theme.js";

/** Markdown остаётся текстом: заголовки, списки, абзацы, отступы и fenced code сохраняются. */
export function renderMarkdown(text: string, _options: TextOptions): string {
  return safeText(text);
}
