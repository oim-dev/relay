import clsx from "clsx";
import { Link } from "react-router-dom";
import { isDefined, isEmptyArray, isNonEmptyArray } from "shared/value-predicates";
import { PLAN_STATUS_COUNT_LABELS } from "../../config/overview.config";
import { MetricDisclosure } from "../metric-disclosure/metric-disclosure";
import { PlanCard } from "./ui/plan-card/plan-card";
import type { PlanSummariesProps } from "./types/plan-summaries-props.type";
import styles from "./styles/plan-summaries.module.css";

/**
 * Показывает статусы всех планов и карточки активных планов с фактическим прогрессом,
 * а также сигналы планирования: открытые планы с выполненным составом и исполняемую
 * работу вне открытых планов.
 *
 * Используется для:
 *  - ответа на вопрос «где продолжить работу»
 *  - отличия завершённого статуса от фактической готовности
 */
export const PlanSummaries = (props: PlanSummariesProps) => {
  const { plans, operator, snapshotVersion, basePath, className, ...rootAttrs } = props;
  const { unplannedWork, openPlansComplete } = operator;
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
      <MetricDisclosure
        title="Состав выполнен, план открыт"
        hint="Черновые и активные планы, весь непустой состав которых фактически выполнен. Завершение плана дополнительно требует итог."
        request={{ metric: "open-plans-complete" }}
        preview={{
          total: openPlansComplete.total,
          hasMore: openPlansComplete.hasMore,
          entries: openPlansComplete.items.map((plan) => ({ kind: "plan", id: plan.id, plan })),
        }}
        emptyText="Нет открытых планов с полностью выполненным составом."
        snapshotVersion={snapshotVersion}
        basePath={basePath}
      />
      <MetricDisclosure
        title="Вне открытых планов"
        summary={`в работе ${unplannedWork.byColumn.inProgress} · на проверке ${unplannedWork.byColumn.review}`}
        hint="Задачи «В работе» и «На проверке», которые явно не входят ни в один черновой или активный план. Это сигнал для пересмотра планирования, а не ошибка."
        request={{ metric: "unplanned-work" }}
        preview={{
          total: unplannedWork.total,
          hasMore: unplannedWork.hasMore,
          entries: unplannedWork.items.map((task) => ({ kind: "task", id: task.id, task })),
        }}
        emptyText="Вся исполняемая работа входит в открытые планы."
        shouldShowColumn
        snapshotVersion={snapshotVersion}
        basePath={basePath}
      />
    </div>
  );
};
