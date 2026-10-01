import { useId, useRef, useState } from "react";
import clsx from "clsx";
import { Button } from "@mantine/core";
import { ChevronDown, ChevronUp } from "lucide-react";
import { isDefined } from "shared/value-predicates";
import { useMetricList } from "../../hooks/use-metric-list.hook";
import { MetricEntry } from "../metric-entry/metric-entry";
import { MetricFrame } from "../metric-frame/metric-frame";
import type { MetricDisclosureProps } from "./types/metric-disclosure-props.type";
import styles from "./styles/metric-disclosure.module.css";

/**
 * Показывает показатель оператора: полное число, его смысл и, по действию, весь состав
 * постранично на том же срезе, что и обзор. Пока полный список читается, видна подборка;
 * при обновлении проекта раскрытие, загруженный объём, фокус и прокрутка сохраняются.
 *
 * Используется для:
 *  - групп проверки, блокеров, работы вне планов, досок, планов и подготовки выпуска
 */
export const MetricDisclosure = (props: MetricDisclosureProps) => {
  const {
    title,
    headingLevel = 3,
    summary = null,
    hint = null,
    request,
    preview,
    isPreviewShown = false,
    emptyText,
    shouldShowColumn = false,
    variant = "tile",
    tone = "neutral",
    snapshotVersion,
    basePath,
    className,
    ...rootAttrs
  } = props;
  const headingId = useId();
  const listId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [isExpanded, setExpanded] = useState(false);
  const list = useMetricList(isExpanded ? request : null, snapshotVersion, preview.entries);
  const Heading = headingLevel === 3 ? "h3" : "h4";
  const isListShown = isExpanded || isPreviewShown;
  const entries = isExpanded ? list.entries : preview.entries;
  const boardScale = Math.max(
    0,
    ...entries.map((entry) => (entry.kind === "board" ? entry.board.tasks.remaining : 0)),
  );
  const canExpand = isExpanded || (isPreviewShown ? preview.hasMore : preview.total > 0);
  const toggleLabel = isExpanded
    ? isPreviewShown
      ? "Свернуть до подборки"
      : "Свернуть список"
    : `Показать все ${preview.total}`;
  const ToggleIcon = isExpanded ? ChevronUp : ChevronDown;
  const previewNote =
    !isExpanded && isPreviewShown && preview.hasMore
      ? `Показано ${preview.entries.length} из ${preview.total}`
      : null;
  const emptyNote = !isExpanded && preview.total === 0 ? emptyText : null;
  const emptyMark = preview.total === 0 ? "" : undefined;
  const controlsId = isListShown ? listId : undefined;
  // Состояние полного чтения относится только к раскрытому списку, не к подборке.
  const frameState = isExpanded
    ? {
        isBusy: list.isBusy,
        statusText: list.statusText,
        loadedNote: list.loadedNote,
        emptyText,
        error: list.error,
        hasMore: list.hasMore,
      }
    : {
        isBusy: false,
        statusText: null,
        loadedNote: null,
        emptyText: null,
        error: null,
        hasMore: false,
      };
  const entryIds = entries.map((entry) => entry.id);
  return (
    <section
      {...rootAttrs}
      className={clsx(styles.root, className)}
      data-variant={variant}
      data-tone={tone}
      data-empty={emptyMark}
      aria-labelledby={headingId}
    >
      <Heading id={headingId} ref={headingRef} className={styles.title} tabIndex={-1}>
        <span className={styles.label}>{title}</span>
        <span className={styles.count}>{preview.total}</span>
        {isDefined(summary) && <span className={styles.summary}>{summary}</span>}
      </Heading>
      {isDefined(hint) && <p className={styles.hint}>{hint}</p>}
      {isListShown && (
        <MetricFrame
          id={listId}
          label={title}
          entryIds={entryIds}
          focusFallbackRef={headingRef}
          {...frameState}
          isLoadingMore={list.isLoadingMore}
          onMore={list.loadMore}
          onRetry={list.retry}
        >
          {entries.map((entry) => (
            <li key={entry.id} data-entry-id={entry.id}>
              <MetricEntry
                entry={entry}
                snapshotVersion={snapshotVersion}
                boardScale={boardScale}
                shouldShowColumn={shouldShowColumn}
                basePath={basePath}
              />
            </li>
          ))}
        </MetricFrame>
      )}
      {isDefined(emptyNote) && <p className={styles.note}>{emptyNote}</p>}
      {isDefined(previewNote) && <p className={styles.note}>{previewNote}</p>}
      {canExpand && (
        <Button
          size="compact-sm"
          variant="subtle"
          className={styles.toggle}
          aria-expanded={isExpanded}
          aria-controls={controlsId}
          aria-label={`${toggleLabel}: ${title}`}
          leftSection={<ToggleIcon size={14} aria-hidden="true" />}
          onClick={() => setExpanded(!isExpanded)}
        >
          {toggleLabel}
        </Button>
      )}
    </section>
  );
};
