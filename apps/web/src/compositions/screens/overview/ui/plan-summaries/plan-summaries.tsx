import clsx from "clsx";
import { Link } from "react-router-dom";
import { isDefined, isEmptyArray, isNonEmptyArray } from "shared/value-predicates";
import { PLAN_STATUS_COUNT_LABELS } from "../../config/overview.config";
import { PlanCard } from "./ui/plan-card/plan-card";
import type { PlanSummariesProps } from "./types/plan-summaries-props.type";
import styles from "./styles/plan-summaries.module.css";

/**
 * Показывает статусы всех планов и карточки активных планов с фактическим прогрессом.
 *
 * Используется для:
 *  - ответа на вопрос «где продолжить работу»
 *  - отличия завершённого статуса от фактической готовности
 */
export const PlanSummaries = (props: PlanSummariesProps) => {
  const { plans, basePath, className, ...rootAttrs } = props;
  const statusItems = Object.entries(PLAN_STATUS_COUNT_LABELS).map(([status, label]) => ({
    status,
    label,
    count: plans.byStatus[status as keyof typeof PLAN_STATUS_COUNT_LABELS],
  }));
  const notReadyNote =
    plans.completedNotReady > 0
      ? `Завершены по статусу, но состав фактически не выполнен: ${plans.completedNotReady}`
      : null;
  const planItems = plans.active.items;
  const shouldShowEmptyState = isEmptyArray(planItems);
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <ul className={styles.statuses} aria-label="Планы по статусам">
        {statusItems.map((item) => (
          <li key={item.status}>
            {item.label} <strong>{item.count}</strong>
          </li>
        ))}
      </ul>
      {isDefined(notReadyNote) && <p className={styles.warning}>{notReadyNote}</p>}
      {isNonEmptyArray(planItems) && (
        <ul className={styles.list} aria-label="Активные планы">
          {planItems.map((plan) => (
            <li key={plan.id}>
              <PlanCard plan={plan} basePath={basePath} />
            </li>
          ))}
        </ul>
      )}
      {shouldShowEmptyState && (
        <p className={styles.empty}>
          Активных планов нет. <Link to={`${basePath}/plans`}>Открыть каталог планов</Link>
        </p>
      )}
    </div>
  );
};
