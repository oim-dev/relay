import useSWRSubscription from "swr/subscription";
import type { SWRSubscriptionOptions, SWRSubscriptionResponse } from "swr/subscription";
import { subscribeWorkspace } from "infra/workspace-events";
import type { WorkspaceSignal } from "infra/workspace-events";
import { useGetProject } from "./use-get-project/use-get-project.hook";

/** Состояние синхронизации рабочего проекта. */
export type ProjectConnection = WorkspaceSignal;

/**
 * Разделяет подписку проекта и публикует состояние совместной работы.
 */
export const useProjectConnection = (): SWRSubscriptionResponse<ProjectConnection, Error> => {
  const project = useGetProject();
  const key = project.data ? (["project/events", project.data.id] as const) : null;
  return useSWRSubscription(
    key,
    (scope, { next }: SWRSubscriptionOptions<ProjectConnection, Error>) =>
      subscribeWorkspace(scope[1], (signal) => next(null, { ...signal })),
  );
};
