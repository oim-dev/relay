import type { Components } from "react-markdown";

const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

/**
 * Встраивает Markdown в иерархию страницы, не создавая второй h1 и не изменяя исходный текст.
 */
export const getHeadingTags = (
  offset: number,
): Pick<Components, "h1" | "h2" | "h3" | "h4" | "h5" | "h6"> => ({
  h1: HEADING_TAGS[offset] ?? "h6",
  h2: HEADING_TAGS[offset + 1] ?? "h6",
  h3: HEADING_TAGS[offset + 2] ?? "h6",
  h4: HEADING_TAGS[offset + 3] ?? "h6",
  h5: HEADING_TAGS[offset + 4] ?? "h6",
  h6: "h6",
});
