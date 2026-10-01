import { useId, useRef, useState } from "react";
import clsx from "clsx";
import { Button } from "@mantine/core";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Link } from "react-router-dom";
import { TASK_COLUMNS } from "domains/board-tasks";
import type { OverviewMetricEntry } from "domains/product-overview";
import { UNTITLED } from "../../config/overview.config";
import { pluralWord } from "../../helpers/plural";
import { useMetricList } from "../../hooks/use-metric-list.hook";
import { MetricFrame } from "../metric-frame/metric-frame";
import { MetricTask } from "../metric-task/metric-task";
import type { MetricBlockerProps } from "./types/metric-blocker-props.type";
import styles from "./styles/metric-blocker.module.css";
import listAction from "../../styles/list-action.module.css";

/**
 * Показывает задачу, которая напрямую задерживает незавершённую работу, и сколько
 * задач она блокирует: зависимостью или как незавершённая подзадача. Затронутые задачи
 * раскрываются по действию до полного списка того же среза.
 * Это прямое влияние, не критический путь и не рекомендация приоритета.
 *
 * Используется для:
 *  - подборки и полного списка блокеров в «Требует внимания»
 */
export const MetricBlocker = (props: MetricBlockerProps) => {
  const { entry, snapshotVersion, basePath, className, ...rootAttrs } = props;
  const { blocker } = entry;
  const listId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [isExpanded, setExpanded] = useState(false);
  const previewEntries: OverviewMetricEntry[] = blocker.affected.items.map((task) => ({
    kind: "affected",
    id: task.id,
    task,
  }));
  const list = useMetricList(
    isExpanded ? { metric: "blocker-affected", blocker: blocker.id } : null,
    snapshotVersion,
    previewEntries,
  );
  const affectedEntries = list.entries.flatMap((item) => (item.kind === "affected" ? [item] : []));
  const title = blocker.title === "" ? UNTITLED : blocker.title;
  const taskPath = `${basePath}/boards/${encodeURIComponent(blocker.board.slug)}/${encodeURIComponent(blocker.id)}`;
  const columnLabel = TASK_COLUMNS.find((column) => column.value === blocker.column)?.label;
  const count = blocker.affected.total;
  const impactLabel =
    `Блокирует ${count} ` +
    `${pluralWord(count, ["незавершённую задачу", "незавершённые задачи", "незавершённых задач"])} напрямую`;
  const toggleLabel = isExpanded ? "Скрыть затронутые задачи" : `Показать затронутые: ${count}`;
  const ToggleIcon = isExpanded ? ChevronUp : ChevronDown;
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <Link to={taskPath} className={styles.link}>
        <span className={styles.key}>{blocker.key}</span>
        <span className={styles.title}>{title}</span>
      </Link>
      <p className={styles.meta}>
        <span>{blocker.board.name}</span>
        <span data-column={blocker.column}>{columnLabel}</span>
      </p>
      <p className={styles.impact}>{impactLabel}</p>
      {count > 0 && (
        <Button
          classNames={{ root: listAction.root, label: listAction.label }}
          ref={toggleRef}
          size="compact-sm"
          variant="subtle"
          className={styles.toggle}
          aria-expanded={isExpanded}
          aria-controls={listId}
          aria-label={`${toggleLabel} — ${blocker.key}`}
          leftSection={<ToggleIcon size={14} aria-hidden="true" />}
          onClick={() => setExpanded(!isExpanded)}
        >
          {toggleLabel}
        </Button>
      )}
      {isExpanded && (
        <MetricFrame
          id={listId}
          className={styles.affected}
          label={`Задачи, которые ${blocker.key} блокирует напрямую`}
          entryIds={affectedEntries.map((item) => item.id)}
          focusFallbackRef={toggleRef}
          isBusy={list.isBusy}
          statusText={list.statusText}
          loadedNote={list.loadedNote}
          emptyText="Задача больше никого не блокирует."
          error={list.error}
          hasMore={list.hasMore}
          isLoadingMore={list.isLoadingMore}
          onMore={list.loadMore}
          onRetry={list.retry}
        >
          {affectedEntries.map((item) => (
            <li key={item.id} data-entry-id={item.id}>
              <MetricTask entry={item} shouldShowColumn basePath={basePath} />
            </li>
          ))}
        </MetricFrame>
      )}
    </div>
  );
};
