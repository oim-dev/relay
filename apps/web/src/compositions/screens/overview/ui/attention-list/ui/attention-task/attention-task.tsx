import clsx from "clsx";
import { Link } from "react-router-dom";
import { isDefined } from "shared/value-predicates";
import { UNTITLED } from "../../../../config/overview.config";
import type { AttentionTaskProps } from "./types/attention-task-props.type";
import styles from "./styles/attention-task.module.css";

const RELATION_LABELS = { dependency: "зависимость", subtask: "подзадача" } as const;

/**
 * Показывает задачу с доской, критериями и причинами блокировки.
 *
 * Используется для:
 *  - перехода из обзора к окну задачи на её доске
 */
export const AttentionTask = (props: AttentionTaskProps) => {
  const { task, columnLabel, basePath, className, ...rootAttrs } = props;
  const taskPath = `${basePath}/boards/${encodeURIComponent(task.board.slug)}/${encodeURIComponent(task.id)}`;
  const title = task.title === "" ? UNTITLED : task.title;
  const criteriaLabel =
    task.acceptance.total === 0
      ? null
      : `Критерии ${task.acceptance.completed} из ${task.acceptance.total}`;
  const blockerNames = task.blockers.items
    .map((blocker) => `${blocker.key} (${RELATION_LABELS[blocker.relation]})`)
    .join(", ");
  const hiddenBlockers = task.blockers.total - task.blockers.items.length;
  const blockerSuffix = hiddenBlockers > 0 ? ` и ещё ${hiddenBlockers}` : "";
  const blockersLabel = task.blockers.total === 0 ? null : `Ждёт: ${blockerNames}${blockerSuffix}`;
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <Link to={taskPath} className={styles.link}>
        <span className={styles.key}>{task.key}</span>
        <span className={styles.title}>{title}</span>
      </Link>
      <p className={styles.meta}>
        <span>{task.board.name}</span>
        {isDefined(columnLabel) && <span>{columnLabel}</span>}
        {isDefined(criteriaLabel) && <span>{criteriaLabel}</span>}
      </p>
      {isDefined(blockersLabel) && <p className={styles.blockers}>{blockersLabel}</p>}
    </div>
  );
};
