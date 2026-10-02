import {
  entityDetailSchema,
  entitySavedSchema,
  entitiesPageSchema,
  entitiesQuerySchema,
  defaultDocumentSections,
} from "@relay/contracts/entities";
import type { EntitySaved, EntitiesQuery } from "@relay/contracts/entities";
import { getProjectApi } from "infra/tasks-api";
import { throwDocumentFailure } from "../errors/document-errors";
import type {
  DocumentInput,
  KnowledgeDocument,
  LibrarySettings,
  DocumentSection,
  DocumentEntity,
  MaterialCatalogFilters,
  MaterialCatalogPage,
  MaterialPropertyChanges,
} from "../types/document.type";

/** Размер одной порции каталога. */
const CATALOG_LIMIT = 40;

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
      documentFormat: entry.document?.format ?? "markdown",
      ...(entry.document?.url === undefined ? {} : { url: entry.document.url }),
      tags: entry.document?.tags ?? [],
      relations: fields.relations ?? [],
      legacyLinks: fields.links.map((link) => ({
        target: { kind: link.kind, id: link.kind === "product" ? "passport" : link.id },
        type: "documents" as const,
        description: "",
      })),
    };
  } catch (failure) {
    return throwDocumentFailure(failure);
  }
};

/**
 * Атомарно сохраняет содержание, свойства, формат, теги и отношения материала без автоматического повтора.
 * Адрес передаётся только для формата link: Core запрещает url у markdown и снимает его при смене формата.
 * targets не передаются: при изменении сохраняются совместимые links, при создании их нет.
 */
export const saveDocument = async (
  projectId: string,
  input: DocumentInput,
  requestId: string,
  existing?: { id: string; revision: number },
): Promise<EntitySaved> => {
  try {
    const api = getProjectApi(projectId).entities;
    const { url, ...content } = input;
    const isLink = input.documentFormat === "link";
    const fields = {
      kind: "document" as const,
      ...content,
      ...(isLink && url !== undefined ? { url } : {}),
    };
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

/**
 * Переводит условия каталога в фильтры сервера; архив входит только в своё представление.
 * Общие для выдачи и счётчиков, чтобы числа совпадали со списком.
 */
export const toMaterialFilterQuery = (filters: MaterialCatalogFilters) => {
  const { q, view, section, kind, target, tags = [], format = null, status = null } = filters;
  const sectionFilter = section ?? (view === "none" ? "none" : undefined);
  const isSystemView = section === null;
  const isUnattached = filters.unattached === true || (view === "unattached" && isSystemView);
  const statusFilter =
    view === "draft" && isSystemView ? "draft" : view === "archived" ? null : status;
  return {
    archived: view === "archived" && isSystemView ? ("true" as const) : ("false" as const),
    ...(q === "" ? {} : { q }),
    ...(sectionFilter === undefined ? {} : { section: sectionFilter }),
    ...(kind === null ? {} : { documentKind: kind }),
    ...(target === null ? {} : { target }),
    ...(tags.length === 0 ? {} : { tags }),
    ...(format === null ? {} : { documentFormat: format }),
    ...(isUnattached ? { unattached: "true" as const } : {}),
    ...(statusFilter === null ? {} : { status: statusFilter }),
    ...(view === "pinned" && isSystemView ? { pinned: "true" as const } : {}),
  };
};

/** Добавляет к фильтрам каталога порцию и порядок выдачи. */
const toCatalogQuery = (
  filters: MaterialCatalogFilters,
  offset: number,
  version: string | undefined,
): EntitiesQuery => ({
  kind: "document",
  offset,
  limit: CATALOG_LIMIT,
  sort: filters.view === "recent" ? "updated" : filters.sort,
  ...(version === undefined ? {} : { version }),
  ...toMaterialFilterQuery(filters),
});

/** Читает одну порцию каталога в версии предыдущей порции той же выдачи. */
export const getMaterialCatalogPage = async (
  projectId: string,
  filters: MaterialCatalogFilters,
  offset: number,
  version: string | undefined,
): Promise<MaterialCatalogPage> => {
  try {
    const response = await getProjectApi(projectId).entities.listEntities(
      entitiesQuerySchema.parse(toCatalogQuery(filters, offset, version)),
    );
    const page = entitiesPageSchema.parse(response.data);
    return {
      items: page.items,
      total: page.total,
      nextOffset: page.nextOffset,
      version: page.version,
      counts: page.libraryCounts ?? {},
    };
  } catch (failure) {
    return throwDocumentFailure(failure);
  }
};

/**
 * Меняет закрепление, раздел или состояние под прочитанной ревизией;
 * содержание, теги и прикрепления сохраняются.
 */
export const updateMaterialProperties = async (
  projectId: string,
  material: { id: string; revision: number },
  changes: MaterialPropertyChanges,
  requestId: string,
): Promise<EntitySaved> => {
  try {
    const response = await getProjectApi(projectId).entities.updateEntity({
      ref: material.id,
      ifRevision: material.revision,
      changes: { kind: "document", ...changes },
      requestId,
    });
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

/**
 * Постоянный переход к сущности; совместимые маршруты разрешают родительский контекст.
 * Проект ведёт на «Обзор». Карточка доски не содержит slug, поэтому адрес доски строится
 * по каталогу досок (boardSlugs); без него — в контекст связей доски.
 */
export const documentEntityHref = (
  base: string,
  entity: DocumentEntity,
  boardSlugs?: ReadonlyMap<string, string>,
): string => {
  const { kind, id } = entity.ref;
  const key = encodeURIComponent(entity.key);
  const boardSlug = kind === "board" ? boardSlugs?.get(id) : undefined;
  if (kind === "document") return `${base}/documents/${id}`;
  if (kind === "work-plan") return `${base}/plans/${id}`;
  if (kind === "release") return `${base}/releases/${id}`;
  if (kind === "task") return `${base}/tasks/${id}`;
  if (kind === "feature") return `${base}/product/features/${key}`;
  if (kind === "scenario") return `${base}/product/scenarios/${key}`;
  if (kind === "implementation") return `${base}/product/implementations/${key}`;
  if (kind === "application") return `${base}/product/applications/${key}`;
  if (kind === "product") return `${base}/product/passport`;
  if (kind === "project") return base;
  if (boardSlug !== undefined) return `${base}/boards/${encodeURIComponent(boardSlug)}`;
  return `${base}/relations?root=${encodeURIComponent(`${kind}:${id}`)}`;
};
