import { Check, Circle, CircleAlert, CircleDot, ScanEye } from "lucide-react";
import { PLANNING_TASK_LABELS, PLANNING_TASK_TONES } from "domains/planning";
import { StatusBadge } from "ui/status-badge";
import { isDefined } from "shared/value-predicates";
import type { PlanTaskProps } from "./types/plan-task-props.type";
import styles from "./styles/plan-task.module.css";

/**
 * Представляет задачу компактной строкой с собственной доской и состоянием.
 * Колонка задачи и выполнение её обязательств показаны раздельно: «Готово» без
 * выполненных обязательств отмечено предупреждением.
 *
 * Используется для:
 *  - просмотра состава этапа и объяснения внешнего ожидания
 */
export const PlanTask = (props: PlanTaskProps) => {
  const { task, onOpen } = props;
  const Icon = task.isCompleted
    ? Check
    : {
        done: CircleAlert,
        "in-progress": CircleDot,
        review: ScanEye,
        inbox: Circle,
        ready: Circle,
        cancelled: Circle,
      }[task.status];
  const iconState = task.isCompleted
    ? "completed"
    : task.status === "done"
      ? "unmet"
      : task.status === "in-progress"
        ? "active"
        : task.status;
  const hasBlocker = isDefined(task.blocker);
  return (
    <button className={styles.root} type="button" onClick={onOpen}>
      <span className={styles.statusIcon} data-state={iconState} aria-hidden="true">
        <Icon size={16} />
      </span>
      <span className={styles.body}>
        <span className={styles.title}>{task.title}</span>
        <span className={styles.meta}>
          <span className={styles.key}>{task.key}</span>
          <span>{task.board}</span>
        </span>
        {hasBlocker && (
          <span className={styles.blocker}>
            <CircleAlert size={14} aria-hidden="true" />
            {task.blocker}
          </span>
        )}
      </span>
      <StatusBadge tone={PLANNING_TASK_TONES[task.status]} className={styles.status}>
        {PLANNING_TASK_LABELS[task.status]}
      </StatusBadge>
    </button>
  );
};
