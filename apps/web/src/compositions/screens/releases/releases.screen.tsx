import { useProjectId } from "domains/project";
import { PageStage } from "ui/page-stage";
import { ReleasesView } from "./ui/releases-view/releases-view";

/**
 * Открывает самостоятельные релизы в изолированной области выбранного проекта
 * на общей сцене страницы.
 *
 * Используется для:
 *  - выбора состава и состояния будущего выпуска
 */
export const ReleasesScreen = () => {
  const projectId = useProjectId();
  return (
    <PageStage>
      <ReleasesView key={projectId} />
    </PageStage>
  );
};
