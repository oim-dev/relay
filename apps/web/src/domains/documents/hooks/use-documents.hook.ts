import { useEffect } from "react";
import useSWR from "swr";
import type { SWRResponse } from "swr";
import { subscribeWorkspace } from "infra/workspace-events";
import { subscribeMaterialsChanged } from "../operations/materials-changes";
import { getDocument, getLibrarySettings } from "../adapters/documents.adapter";
import { DocumentAccessError } from "../errors/document-errors";
import type { KnowledgeDocument, LibrarySettings } from "../types/document.type";

/** SSE перечитывает подтверждённые данные, не изменяя локальный ввод формы. */
const useDocumentRefresh = (projectId: string, refresh: () => Promise<unknown>): void => {
  useEffect(() => {
    const run = (): void => void refresh().catch(() => undefined);
    const unsubscribeStream = subscribeWorkspace(projectId, (signal) => {
      if (signal.state === "connected") run();
    });
    const unsubscribeLocal = subscribeMaterialsChanged(projectId, run);
    return () => {
      unsubscribeStream();
      unsubscribeLocal();
    };
  }, [projectId, refresh]);
};

/** Адресное чтение материала без полного продуктового снимка. */
export const useDocument = (
  projectId: string,
  ref: string | null,
): SWRResponse<KnowledgeDocument, Error> => {
  const response = useSWR<KnowledgeDocument, Error>(
    ref === null ? null : ["document", projectId, ref],
    () => getDocument(projectId, ref ?? ""),
    { shouldRetryOnError: false },
  );
  useDocumentRefresh(projectId, response.mutate);
  if (response.error && !(response.error instanceof DocumentAccessError)) throw response.error;
  return response;
};

/** Общая структура библиотеки с независимым серверным кешем. */
export const useLibrarySettings = (projectId: string): SWRResponse<LibrarySettings, Error> => {
  const response = useSWR<LibrarySettings, Error>(
    ["document-library", projectId],
    () => getLibrarySettings(projectId),
    { shouldRetryOnError: false },
  );
  useDocumentRefresh(projectId, response.mutate);
  if (response.error && !(response.error instanceof DocumentAccessError)) throw response.error;
  return response;
};
