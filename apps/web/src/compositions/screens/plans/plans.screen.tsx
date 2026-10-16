import { PlanningWorkspace } from "compositions/widgets/planning-workspace";
import { useProjectId } from "domains/project";
import { PageStage } from "ui/page-stage";

/**
 * Открывает пространство планов выбранного проекта на общей сцене страницы.
 *
 * Используется для:
 *  - просмотра серверного каталога и адресных подробностей плана
 */
export const PlansScreen = () => {
  const projectId = useProjectId();
  return (
    <PageStage>
      <PlanningWorkspace key={projectId} />
    </PageStage>
  );
};
