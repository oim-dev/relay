import useSWR from "swr";
import { useProjectId } from "../providers/project-scope/context";
import { useGetProject } from "./use-get-project/use-get-project.hook";
import { getProjectSynchronization, requestProjectSynchronization } from "../synchronization";
import type { ProjectSynchronization, ProjectSynchronizationError } from "../synchronization";

/** Небольшой отдельный статус: обновление не перечитывает продукт и не сбрасывает формы. */
export const useProjectSynchronization = () => {
  const projectId = useProjectId();
  const project = useGetProject();
  const key = project.data?.hasBackgroundSynchronization
    ? ["project/synchronization", projectId]
    : null;
  return useSWR<ProjectSynchronization, ProjectSynchronizationError>(
    key,
    () => getProjectSynchronization(projectId),
    { refreshInterval: 3000 },
  );
};

/** Изолирует результат запроса по проектному ключу кеша. */
export const useRequestProjectSynchronization = () => {
  const projectId = useProjectId();
  const status = useProjectSynchronization();
  return async () => {
    const result = await requestProjectSynchronization(projectId);
    await status.mutate(result, { revalidate: false });
  };
};
