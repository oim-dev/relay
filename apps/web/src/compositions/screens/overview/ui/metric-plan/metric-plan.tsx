import clsx from "clsx";
import { Link } from "react-router-dom";
import { PLAN_STATUS_LABELS, UNTITLED } from "../../config/overview.config";
import type { MetricPlanProps } from "./types/metric-plan-props.type";
import styles from "./styles/metric-plan.module.css";

/**
 * Показывает план показателя: собственный статус отдельно от фактического выполнения
 * состава задач и этапов.
 *
 * Используется для:
 *  - открытых планов с выполненным составом и готовых планов вне релизов
 *  - перехода к плану
 */
export const MetricPlan = (props: MetricPlanProps) => {
  const { entry, basePath, className, ...rootAttrs } = props;
  const { plan } = entry;
  const title = plan.title === "" ? UNTITLED : plan.title;
  const metaItems = [
    `Статус: ${PLAN_STATUS_LABELS[plan.status]}`,
    `Задачи выполнены: ${plan.tasks.completed} из ${plan.tasks.total}`,
    `Этапы: ${plan.stages.completed} из ${plan.stages.total}`,
  ];
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <Link to={`${basePath}/plans/${encodeURIComponent(plan.id)}`} className={styles.link}>
        <span className={styles.key}>{plan.key}</span>
        <span className={styles.title}>{title}</span>
      </Link>
      <p className={styles.meta}>
        {metaItems.map((item) => (
          <span key={item}>{item}</span>
        ))}
      </p>
    </div>
  );
};
