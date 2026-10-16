import clsx from "clsx";
import { useId } from "react";
import { formatWorkTime, getWorkPointPresentation } from "domains/work-history";
import { MarkdownView } from "ui/markdown-view";
import { isNonEmptyArray } from "shared/value-predicates";
import { getPointMaterials } from "./helpers/point-materials";
import { getPointReadingGuide } from "./helpers/point-reading-guide";
import type { PointReportProps } from "./types/point-report-props.type";
import styles from "./styles/point-report.module.css";

/**
 * Объясняет вид открытой записи и показывает полный материал.
 *
 * Используется для:
 *  - чтения длинных Markdown-материалов без навигации между их разделами
 *  - различения плана, промежуточных результатов и завершённой работы
 */
export const PointReport = (props: PointReportProps) => {
  const { detail, titleRef, className, ...rootAttrs } = props;
  const headingId = useId();
  const { point, session, run } = detail;
  const presentation = getWorkPointPresentation(point, run, session);
  const readingGuide = getPointReadingGuide(detail);
  const timeLabel = formatWorkTime(point.at);
  const summary = detail.checkpoint?.summary ?? "";
  const hasSummary = summary.trim() !== "";
  const materialItems = getPointMaterials(detail);
  const hasMaterials = isNonEmptyArray(materialItems);

  return (
    <article {...rootAttrs} className={clsx(styles.root, className)} aria-labelledby={headingId}>
      <header className={styles.header}>
        <p className={styles.meta}>
          <span className={styles.kind}>{presentation.label}</span>
          <time dateTime={point.at}>{timeLabel}</time>
        </p>
        <p className={styles.explanation}>{readingGuide.description}</p>
        <h2 id={headingId} ref={titleRef} className={styles.title} tabIndex={-1} data-autofocus>
          {point.title}
        </h2>
      </header>
      {hasSummary && <p className={styles.summary}>{summary}</p>}
      {materialItems.map((material) => (
        <section key={material.label} className={styles.material}>
          <h3 className={styles.materialTitle}>{material.label}</h3>
          <MarkdownView
            text={material.text}
            headingStartLevel={4}
            focusableBlocks
            className={styles.markdown}
          />
        </section>
      ))}
      {!hasMaterials && (
        <p className={styles.empty}>Дополнительный текст в этой точке не сохранён.</p>
      )}
    </article>
  );
};
