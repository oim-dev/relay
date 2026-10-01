import { useId } from "react";
import clsx from "clsx";
import type { OverviewOperatorTask, OverviewPreview } from "domains/product-overview";
import { MetricDisclosure } from "../../../metric-disclosure/metric-disclosure";
import type { MetricPreview } from "../../../metric-disclosure/types/metric-disclosure-props.type";
import type { ReviewObligationsProps } from "./types/review-obligations-props.type";
import styles from "./styles/review-obligations.module.css";

/** Подборка задач в общем виде записей показателя. */
const toPreview = (preview: OverviewPreview<OverviewOperatorTask>): MetricPreview => ({
  total: preview.total,
  hasMore: preview.hasMore,
  entries: preview.items.map((task) => ({ kind: "task", id: task.id, task })),
});

/**
 * Делит все задачи на проверке на две непересекающиеся группы: обязательства выполнены
 * и остались обязательства с причинами. Сумма групп равна числу задач на проверке.
 * Готовность обязательств позволяет рассмотреть завершение, но не заменяет проверку
 * результата и не закрывает задачу.
 *
 * Используется для:
 *  - решения, какие результаты можно принимать и что ещё мешает закрытию
 */
export const ReviewObligations = (props: ReviewObligationsProps) => {
  const { review, snapshotVersion, basePath, className, ...rootAttrs } = props;
  const headingId = useId();
  return (
    <section {...rootAttrs} className={clsx(styles.root, className)} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.title}>
        Обязательства задач на проверке
        <span className={styles.count}>{review.total}</span>
      </h3>
      <p className={styles.hint}>
        Готовность обязательств позволяет рассмотреть завершение; она не заменяет проверку
        результата и не закрывает задачу. Группы не пересекаются и в сумме дают все задачи на
        проверке.
      </p>
      <MetricDisclosure
        className={styles.group}
        title="Обязательства выполнены"
        headingLevel={4}
        variant="plain"
        request={{ metric: "review-obligations-met" }}
        preview={toPreview(review.obligationsMet)}
        emptyText="Нет задач на проверке с выполненными обязательствами."
        snapshotVersion={snapshotVersion}
        basePath={basePath}
      />
      <MetricDisclosure
        className={styles.group}
        title="Остались обязательства"
        headingLevel={4}
        variant="plain"
        hint="Невыполненные критерии приёмки, зависимости или подзадачи."
        request={{ metric: "review-obligations-open" }}
        preview={toPreview(review.obligationsOpen)}
        emptyText="У задач на проверке не осталось невыполненных обязательств."
        snapshotVersion={snapshotVersion}
        basePath={basePath}
      />
    </section>
  );
};
