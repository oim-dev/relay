import clsx from "clsx";
import { Link } from "react-router-dom";
import { TASK_COLUMNS } from "domains/board-tasks";
import { isDefined } from "shared/value-predicates";
import {
  BLOCKER_RELATION_LABELS,
  OBLIGATION_REASON_LABELS,
  UNTITLED,
} from "../../config/overview.config";
import type { MetricTaskProps } from "./types/metric-task-props.type";
import styles from "./styles/metric-task.module.css";

/**
 * Показывает задачу показателя с доской и основанием включения: какие обязательства
 * не выполнены и чего она ждёт, либо как именно её задерживает блокер.
 *
 * Используется для:
 *  - групп проверки, работы вне открытых планов и затронутых задач блокера
 *  - перехода к окну задачи на её доске
 */
export const MetricTask = (props: MetricTaskProps) => {
  const { entry, shouldShowColumn = false, basePath, className, ...rootAttrs } = props;
  const { task } = entry;
  const taskPath = `${basePath}/boards/${encodeURIComponent(task.board.slug)}/${encodeURIComponent(task.id)}`;
  const title = task.title === "" ? UNTITLED : task.title;
  const columnLabel = shouldShowColumn
    ? TASK_COLUMNS.find((column) => column.value === task.column)?.label
    : undefined;
  const details = entry.kind === "task" ? entry.task : null;
  const criteriaLabel =
    isDefined(details) && details.acceptance.total > 0
      ? `Критерии ${details.acceptance.completed} из ${details.acceptance.total}`
      : null;
  const reasonsLabel =
    isDefined(details) && details.reasons.length > 0
      ? `Не выполнено: ${details.reasons.map((reason) => OBLIGATION_REASON_LABELS[reason]).join(", ")}`
      : null;
  const hiddenBlockers = isDefined(details)
    ? details.blockers.total - details.blockers.items.length
    : 0;
  const blockerNames = isDefined(details)
    ? details.blockers.items
        .map((blocker) => `${blocker.key} (${BLOCKER_RELATION_LABELS[blocker.relation]})`)
        .join(", ")
    : "";
  const blockersLabel =
    blockerNames === ""
      ? null
      : `Ждёт: ${blockerNames}${hiddenBlockers > 0 ? ` и ещё ${hiddenBlockers}` : ""}`;
  // Причина и адресные блокеры — одно основание включения: одна плашка, а не две.
  const obligationsLabel = [reasonsLabel, blockersLabel].filter(isDefined).join(". ") || null;
  const relationLabel =
    entry.kind === "affected"
      ? `Связь: ${entry.task.relations.map((relation) => BLOCKER_RELATION_LABELS[relation]).join(" и ")}`
      : null;
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
        {isDefined(relationLabel) && <span>{relationLabel}</span>}
      </p>
      {isDefined(obligationsLabel) && <p className={styles.reasons}>{obligationsLabel}</p>}
    </div>
  );
};
