import { useId, useState } from "react";
import clsx from "clsx";
import { Button } from "@mantine/core";
import { ChevronDown, ChevronUp } from "lucide-react";
import { isDefined, isEmptyArray, isNonEmptyArray } from "shared/value-predicates";
import { AttentionTask } from "../attention-task/attention-task";
import { AttentionFullList } from "./ui/attention-full-list/attention-full-list";
import type { AttentionGroupProps } from "./types/attention-group-props.type";
import styles from "./styles/attention-group.module.css";

/**
 * Показывает одну подборку задач, требующих внимания, с полным числом и пустым состоянием.
 * Ограниченную подборку можно раскрыть до полного списка проекта с тем же фильтром.
 *
 * Используется для:
 *  - групп «В работе», «На проверке» и «Заблокированы»
 */
export const AttentionGroup = (props: AttentionGroupProps) => {
  const {
    title,
    emptyText,
    preview,
    filters,
    shouldShowColumn = false,
    basePath,
    className,
    ...rootAttrs
  } = props;
  const headingId = useId();
  const listId = useId();
  const [isExpanded, setExpanded] = useState(false);
  const taskItems = preview.items;
  const canExpand = preview.hasMore || isExpanded;
  const shouldShowPreview = !isExpanded && isNonEmptyArray(taskItems);
  const emptyNote = !isExpanded && isEmptyArray(taskItems) ? emptyText : null;
  const moreNote =
    !isExpanded && preview.hasMore ? `Показано ${taskItems.length} из ${preview.total}` : null;
  const toggleLabel = isExpanded ? "Свернуть до подборки" : `Показать все ${preview.total}`;
  const ToggleIcon = isExpanded ? ChevronUp : ChevronDown;
  return (
    <section {...rootAttrs} className={clsx(styles.root, className)} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.title}>
        {title}
        <span className={styles.count}>{preview.total}</span>
      </h3>
      <div id={listId} className={styles.content}>
        {shouldShowPreview && (
          <ul className={styles.list}>
            {taskItems.map((task) => (
              <li key={task.id}>
                <AttentionTask task={task} basePath={basePath} />
              </li>
            ))}
          </ul>
        )}
        {isExpanded && (
          <AttentionFullList
            filters={filters}
            previewTasks={taskItems}
            shouldShowColumn={shouldShowColumn}
            basePath={basePath}
          />
        )}
      </div>
      {isDefined(emptyNote) && <p className={styles.note}>{emptyNote}</p>}
      {isDefined(moreNote) && <p className={styles.note}>{moreNote}</p>}
      {canExpand && (
        <Button
          size="compact-sm"
          variant="subtle"
          className={styles.toggle}
          aria-expanded={isExpanded}
          aria-controls={listId}
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
