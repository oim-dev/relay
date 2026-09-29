import { useId } from "react";
import clsx from "clsx";
import { isDefined, isEmptyArray, isNonEmptyArray } from "shared/value-predicates";
import { AttentionTask } from "../attention-task/attention-task";
import type { AttentionGroupProps } from "./types/attention-group-props.type";
import styles from "./styles/attention-group.module.css";

/**
 * Показывает одну подборку задач, требующих внимания, с полным числом и пустым состоянием.
 *
 * Используется для:
 *  - групп «В работе», «На проверке» и «Заблокированы»
 */
export const AttentionGroup = (props: AttentionGroupProps) => {
  const { title, emptyText, preview, basePath, className, ...rootAttrs } = props;
  const headingId = useId();
  const taskItems = preview.items;
  const emptyNote = isEmptyArray(taskItems) ? emptyText : null;
  const moreNote = preview.hasMore ? `Показано ${taskItems.length} из ${preview.total}` : null;
  return (
    <section {...rootAttrs} className={clsx(styles.root, className)} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.title}>
        {title}
        <span className={styles.count}>{preview.total}</span>
      </h3>
      {isNonEmptyArray(taskItems) && (
        <ul className={styles.list}>
          {taskItems.map((task) => (
            <li key={task.id}>
              <AttentionTask task={task} basePath={basePath} />
            </li>
          ))}
        </ul>
      )}
      {isDefined(emptyNote) && <p className={styles.note}>{emptyNote}</p>}
      {isDefined(moreNote) && <p className={styles.note}>{moreNote}</p>}
    </section>
  );
};
