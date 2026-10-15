import clsx from "clsx";
import ReactMarkdown from "react-markdown";
import type { Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownLink } from "ui/markdown-link";
import { MarkdownCheckbox } from "./ui/markdown-checkbox/markdown-checkbox";
import { getHeadingTags } from "./helpers/get-heading-tags";
import { remarkHeadingHierarchy } from "./helpers/remark-heading-hierarchy";
import type { MarkdownViewProps } from "./types/markdown-view-props.type";
import styles from "./styles/markdown-view.module.css";

/**
 * Отображает требования, результаты и обсуждения в читаемой типографике.
 *
 * Используется для:
 *  - безопасного просмотра Markdown со списками, кодом и таблицами
 */
export const MarkdownView = (props: MarkdownViewProps) => {
  const {
    text,
    compact = false,
    emptyText = "Пока не заполнено",
    headingOffset = 0,
    headingStartLevel,
    className,
    ...rootAttrs
  } = props;
  const rootClassName = clsx(styles.root, compact && styles._compact, className);
  const remarkPlugins: NonNullable<Options["remarkPlugins"]> = [remarkGfm];
  if (headingStartLevel !== undefined)
    remarkPlugins.push([remarkHeadingHierarchy, headingStartLevel]);
  const effectiveOffset = headingStartLevel === undefined ? headingOffset : 0;
  if (text.trim() === "")
    return (
      <div {...rootAttrs} className={clsx(rootClassName, styles._empty)}>
        {emptyText}
      </div>
    );
  return (
    <div {...rootAttrs} className={rootClassName}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={{
          input: MarkdownCheckbox,
          a: MarkdownLink,
          ...getHeadingTags(effectiveOffset),
        }}
        skipHtml
      >
        {text}
      </ReactMarkdown>
    </div>
  );
};
