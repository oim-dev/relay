import { BookOpen } from "lucide-react";
import { EntityDocuments } from "compositions/widgets/entity-documents";
import type { PlanOverviewProps } from "./types/plan-overview-props.type";
import styles from "./styles/plan-overview.module.css";

/**
 * Показывает прикреплённые материалы плана.
 *
 * Используется для:
 *  - чтения документов плана
 */
export const PlanOverview = (props: PlanOverviewProps) => {
  const { plan } = props;
  return (
    <div className={styles.root}>
      <section className={styles.section}>
        <h2 className={styles.title}>
          <BookOpen size={16} />
          Материалы плана
        </h2>
        <EntityDocuments target={{ kind: "work-plan", id: plan.id }} />
      </section>
    </div>
  );
};
