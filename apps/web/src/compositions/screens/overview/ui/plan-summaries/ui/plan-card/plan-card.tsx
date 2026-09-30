import clsx from "clsx";
import { Progress } from "@mantine/core";
import { Link } from "react-router-dom";
import { isDefined } from "shared/value-predicates";
import { UNTITLED } from "../../../../config/overview.config";
import type { PlanCardProps } from "./types/plan-card-props.type";
import styles from "./styles/plan-card.module.css";

/**
 * Показывает активный план с этапами и фактическим выполнением задач.
 *
 * Используется для:
 *  - перехода из обзора к плану и его следующему этапу
 */
export const PlanCard = (props: PlanCardProps) => {
  const { plan, basePath, className, ...rootAttrs } = props;
  const title = plan.title === "" ? UNTITLED : plan.title;
  const description = plan.description === "" ? null : plan.description;
  const tasksLabel = `Задачи: ${plan.tasks.completed} из ${plan.tasks.total} (${plan.tasks.percent}%)`;
  const stagesLabel = `Этапы: ${plan.stages.completed} из ${plan.stages.total}`;
  const blockedLabel = plan.tasks.blocked > 0 ? `Заблокировано: ${plan.tasks.blocked}` : null;
  const nextLabel = isDefined(plan.nextStageTitle)
    ? `Следующий этап: ${plan.nextStageTitle}`
    : null;
  const readyLabel = plan.isReady ? "Состав фактически выполнен" : null;
  return (
    <article {...rootAttrs} className={clsx(styles.root, className)}>
      <Link to={`${basePath}/plans/${encodeURIComponent(plan.id)}`} className={styles.link}>
        <span className={styles.key}>{plan.key}</span>
        <span className={styles.title}>{title}</span>
      </Link>
      {isDefined(description) && <p className={styles.description}>{description}</p>}
      <Progress
        value={plan.tasks.percent}
        size="sm"
        color="var(--tasks-completed)"
        classNames={{ root: styles.progress }}
        aria-label={tasksLabel}
      />
      <p className={styles.meta}>
        <span>{tasksLabel}</span>
        <span>{stagesLabel}</span>
        {isDefined(blockedLabel) && <span>{blockedLabel}</span>}
      </p>
      {isDefined(nextLabel) && <p className={styles.meta}>{nextLabel}</p>}
      {isDefined(readyLabel) && <p className={styles.ready}>{readyLabel}</p>}
    </article>
  );
};
