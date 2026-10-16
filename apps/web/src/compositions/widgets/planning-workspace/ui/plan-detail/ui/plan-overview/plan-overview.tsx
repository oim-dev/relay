import { EntityDocuments } from "compositions/widgets/entity-documents";
import type { PlanOverviewProps } from "./types/plan-overview-props.type";

/**
 * Показывает материалы, прикреплённые к плану.
 *
 * Используется для:
 *  - вкладки «Материалы» плана
 */
export const PlanOverview = (props: PlanOverviewProps) => {
  const { plan } = props;
  return <EntityDocuments target={{ kind: "work-plan", id: plan.id }} targetTitle={plan.title} />;
};
