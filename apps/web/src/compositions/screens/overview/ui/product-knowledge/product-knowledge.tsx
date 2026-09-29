import clsx from "clsx";
import type { OverviewKnowledge } from "domains/product-overview";
import { READINESS_LABELS } from "../../config/overview.config";
import { countLabel } from "../../helpers/count-label";
import type { ProductKnowledgeProps } from "./types/product-knowledge-props.type";
import styles from "./styles/product-knowledge.module.css";

const formatReadiness = (counts: OverviewKnowledge["features"]["byStatus"]): string =>
  [
    countLabel(READINESS_LABELS.done, counts.done),
    countLabel(READINESS_LABELS.partial, counts.partial),
    countLabel(READINESS_LABELS.none, counts.none),
  ].join(" · ");

const formatImplementations = (
  implementations: OverviewKnowledge["featureImplementations"],
): string =>
  [
    countLabel("действующих", implementations.active),
    countLabel("снятых", implementations.withdrawn),
    countLabel("готовы", implementations.byStatus.done),
  ].join(" · ");

/**
 * Показывает объём продукта и фактическую готовность требований и реализаций.
 *
 * Используется для:
 *  - понимания, что уже реализовано, а что впереди
 */
export const ProductKnowledge = (props: ProductKnowledgeProps) => {
  const { knowledge, className, ...rootAttrs } = props;
  const { byType } = knowledge.applications;
  const applicationsDetail = [
    countLabel("клиентских", byType.frontend),
    countLabel("серверных", byType.backend),
    countLabel("внутренних", byType.internal),
  ].join(" · ");
  return (
    <dl {...rootAttrs} className={clsx(styles.root, className)}>
      <div className={styles.row}>
        <dt>Фичи</dt>
        <dd className={styles.value}>{knowledge.features.total}</dd>
        <dd className={styles.detail}>{formatReadiness(knowledge.features.byStatus)}</dd>
      </div>
      <div className={styles.row}>
        <dt>Сценарии</dt>
        <dd className={styles.value}>{knowledge.scenarios.total}</dd>
        <dd className={styles.detail}>{formatReadiness(knowledge.scenarios.byStatus)}</dd>
      </div>
      <div className={styles.row}>
        <dt>Приложения</dt>
        <dd className={styles.value}>{knowledge.applications.total}</dd>
        <dd className={styles.detail}>{applicationsDetail}</dd>
      </div>
      <div className={styles.row}>
        <dt>Реализации фич</dt>
        <dd className={styles.value}>{knowledge.featureImplementations.total}</dd>
        <dd className={styles.detail}>{formatImplementations(knowledge.featureImplementations)}</dd>
      </div>
      <div className={styles.row}>
        <dt>Реализации сценариев</dt>
        <dd className={styles.value}>{knowledge.scenarioImplementations.total}</dd>
        <dd className={styles.detail}>
          {formatImplementations(knowledge.scenarioImplementations)}
        </dd>
      </div>
    </dl>
  );
};
