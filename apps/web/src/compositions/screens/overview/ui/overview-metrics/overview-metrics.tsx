import clsx from "clsx";
import { Link } from "react-router-dom";
import { countLabel } from "../../helpers/count-label";
import type { OverviewMetricsProps } from "./types/overview-metrics-props.type";
import styles from "./styles/overview-metrics.module.css";

/**
 * Показывает компактные полные числа проекта с переходом к соответствующим разделам.
 *
 * Используется для:
 *  - быстрой оценки объёма задач, досок, документов и продуктовых знаний
 */
export const OverviewMetrics = (props: OverviewMetricsProps) => {
  const { tasks, boards, documents, knowledge, basePath, className, ...rootAttrs } = props;
  const taskDetail = [
    countLabel("в работе", tasks.byColumn["in-progress"]),
    countLabel("на проверке", tasks.byColumn.review),
    countLabel("готово", tasks.byColumn.done),
  ].join(" · ");
  const boardDetail = [
    countLabel("продукт", boards.byKind.product),
    countLabel("приложения", boards.byKind.application),
    countLabel("инфраструктура", boards.byKind.infrastructure),
  ].join(" · ");
  const documentDetail = [
    countLabel("действующих", documents.byStatus.active),
    countLabel("черновиков", documents.byStatus.draft),
    countLabel("в\u00A0архиве", documents.byStatus.archived),
  ].join(" · ");
  const knowledgeDetail = [
    countLabel("сценариев", knowledge.scenarios.total),
    countLabel("приложений", knowledge.applications.total),
  ].join(" · ");
  return (
    <ul {...rootAttrs} className={clsx(styles.root, className)} aria-label="Сводные показатели">
      <li>
        <Link to={`${basePath}/boards/product`} className={styles.tile}>
          <span className={styles.label}>Задачи</span>
          <span className={styles.value}>{tasks.total}</span>
          <span className={styles.detail}>{taskDetail}</span>
        </Link>
      </li>
      <li>
        <Link to={`${basePath}/boards/product`} className={styles.tile}>
          <span className={styles.label}>Доски</span>
          <span className={styles.value}>{boards.total}</span>
          <span className={styles.detail}>{boardDetail}</span>
        </Link>
      </li>
      <li>
        <Link to={`${basePath}/documents`} className={styles.tile}>
          <span className={styles.label}>Документы</span>
          <span className={styles.value}>{documents.total}</span>
          <span className={styles.detail}>{documentDetail}</span>
        </Link>
      </li>
      <li>
        <Link to={`${basePath}/product/features`} className={styles.tile}>
          <span className={styles.label}>Фичи продукта</span>
          <span className={styles.value}>{knowledge.features.total}</span>
          <span className={styles.detail}>{knowledgeDetail}</span>
        </Link>
      </li>
    </ul>
  );
};
