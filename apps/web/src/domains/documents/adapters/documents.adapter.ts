import { z } from "zod";
import {
  entityDetailSchema,
  entitySavedSchema,
  defaultDocumentSections,
} from "@relay/contracts/entities";
import type { EntitySaved } from "@relay/contracts/entities";
import { getProjectApi, ApiError, getStorageFailureMessage } from "infra/tasks-api";
import type {
  DocumentInput,
  KnowledgeDocument,
  LibrarySettings,
  DocumentSection,
  DocumentEntity,
} from "../types/document.type";

const FAILURE_SCHEMA = z.object({ error: z.object({ message: z.string() }) });

/** Предусмотренная ошибка доступа, записи или версии библиотеки. */
export class DocumentAccessError extends Error {}

/** Сохраняет диагностические дефекты, нормализуя только ожидаемые отказы. */
const throwDocumentFailure = (failure: unknown): never => {
  if (failure instanceof ApiError) {
    const parsed = FAILURE_SCHEMA.safeParse(failure.error);
    throw new DocumentAccessError(
      parsed.success && failure.status < 500
        ? (getStorageFailureMessage(failure) ?? parsed.data.error.message)
        : "Ответ сервера не получен. Перед новой записью перечитайте состояние: операция могла выполниться.",
      { cause: failure },
    );
  }
  if (
    failure instanceof TypeError ||
    (failure instanceof DOMException && failure.name === "AbortError")
  )
    throw new DocumentAccessError(
      "Нет ответа сервера. Перед новой записью перечитайте состояние: повтор может создать дубликат.",
      {
        cause: failure,
      },
    );
  throw failure;
};

/** Читает полное содержание и адресные связи, сохраняя совместимость прежних областей. */
export const getDocument = async (projectId: string, ref: string): Promise<KnowledgeDocument> => {
  try {
    const response = await getProjectApi(projectId).entities.getEntity({ ref, kind: "document" });
    const entry = entityDetailSchema.parse(response.data);
    if (entry.data.kind !== "document") throw new Error("Ответ документа имеет неверный вид");
    const fields = entry.data;
    return {
      id: entry.ref.id,
      key: entry.key,
      revision: entry.revision,
      references: entry.references,
      updatedAt: entry.document?.updatedAt ?? "",
      name: fields.name,
      summary: fields.summary,
      body: fields.body,
      documentKind: fields.documentKind,
      documentStatus: fields.documentStatus ?? "active",
      sectionId: entry.document?.sectionId ?? null,
      pinned: fields.pinned ?? false,
      relations: [
        ...fields.links.map((link) => ({
          target: { kind: link.kind, id: link.kind === "product" ? "passport" : link.id },
          type: "documents" as const,
          description: "",
        })),
        ...(fields.relations ?? []),
      ],
    };
  } catch (failure) {
    return throwDocumentFailure(failure);
  }
};

/** Атомарно сохраняет содержание, свойства и отношения документа без автоматического повтора. */
export const saveDocument = async (
  projectId: string,
  input: DocumentInput,
  requestId: string,
  existing?: { id: string; revision: number },
): Promise<EntitySaved> => {
  try {
    const api = getProjectApi(projectId).entities;
    const fields = { kind: "document" as const, ...input, targets: [] };
    const response = existing
      ? await api.updateEntity({
          ref: existing.id,
          ifRevision: existing.revision,
          changes: fields,
          requestId,
        })
      : await api.createEntity({ data: fields, requestId });
    return entitySavedSchema.parse(response.data);
  } catch (failure) {
    return throwDocumentFailure(failure);
  }
};

/** Читает разделы вместе с ревизией настроек выбранного проекта. */
export const getLibrarySettings = async (projectId: string): Promise<LibrarySettings> => {
  try {
    const response = await getProjectApi(projectId).entities.getEntity({
      ref: `project:${projectId}`,
      kind: "project",
    });
    const entry = entityDetailSchema.parse(response.data);
    if (entry.data.kind !== "project") throw new Error("Ответ настроек имеет неверный вид");
    return {
      ref: `project:${entry.ref.id}`,
      revision: entry.revision,
      sections: entry.data.documentSections ?? defaultDocumentSections,
    };
  } catch (failure) {
    return throwDocumentFailure(failure);
  }
};

/** Меняет только разделы, сохраняя имя, адрес и остальные настройки проекта. */
export const saveLibrarySections = async (
  projectId: string,
  settings: LibrarySettings,
  sections: DocumentSection[],
  requestId: string,
): Promise<void> => {
  try {
    await getProjectApi(projectId).entities.updateEntity({
      ref: settings.ref,
      ifRevision: settings.revision,
      changes: { kind: "project", documentSections: sections },
      requestId,
    });
  } catch (failure) {
    throwDocumentFailure(failure);
  }
};

/** Постоянный переход к сущности; совместимые маршруты разрешают родительский контекст. */
export const documentEntityHref = (base: string, entity: DocumentEntity): string => {
  const { kind, id } = entity.ref;
  const key = encodeURIComponent(entity.key);
  if (kind === "document") return `${base}/documents/${id}`;
  if (kind === "work-plan") return `${base}/plans/${id}`;
  if (kind === "release") return `${base}/releases/${id}`;
  if (kind === "task") return `${base}/tasks/${id}`;
  if (kind === "feature") return `${base}/product/features/${key}`;
  if (kind === "scenario") return `${base}/product/scenarios/${key}`;
  if (kind === "implementation") return `${base}/product/implementations/${key}`;
  if (kind === "application") return `${base}/product/applications/${key}`;
  if (kind === "product") return `${base}/product/passport`;
  if (kind === "project") return `${base}/settings`;
  return `${base}/relations?root=${encodeURIComponent(`${kind}:${id}`)}`;
};
