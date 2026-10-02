import { entitySavedSchema } from "@relay/contracts/entities";
import type { EntitySaved } from "@relay/contracts/entities";
import {
  documentBulkResultSchema,
  documentFacetsSchema,
  entityDocumentsPageSchema,
} from "@relay/contracts/entities/document-catalog";
import { getProjectApi } from "infra/tasks-api";
import { throwDocumentFailure } from "../errors/document-errors";
import { toMaterialFilterQuery } from "./documents.adapter";
import type {
  EntityMaterialsPage,
  MaterialBulkOperation,
  MaterialBulkResult,
  MaterialCatalogFilters,
  MaterialFacets,
  MaterialRelationChange,
  MaterialRevision,
} from "../types/document.type";

/** Размер порции материалов сущности. */
const ENTITY_MATERIALS_LIMIT = 50;

/** Считает каталог по полным данным проекта с теми же условиями, что и выдача. */
export const getMaterialFacets = async (
  projectId: string,
  filters: MaterialCatalogFilters,
): Promise<MaterialFacets> => {
  try {
    const response = await getProjectApi(projectId).entities.getDocumentFacets(
      toMaterialFilterQuery(filters),
    );
    return documentFacetsSchema.parse(response.data);
  } catch (failure) {
    return throwDocumentFailure(failure);
  }
};

/**
 * Применяет одно действие к 1–100 материалам; каждый записывается под своей ревизией.
 * Частичный результат — ожидаемый исход: статусы элементов разбирает вызывающий.
 */
export const bulkChangeMaterials = async (
  projectId: string,
  items: MaterialRevision[],
  operation: MaterialBulkOperation,
  requestId: string,
): Promise<MaterialBulkResult> => {
  try {
    const response = await getProjectApi(projectId).entities.bulkChangeDocuments({
      items: items.map((item) => ({ ref: item.id, ifRevision: item.revision })),
      operation,
      requestId,
    });
    return documentBulkResultSchema.parse(response.data);
  } catch (failure) {
    return throwDocumentFailure(failure);
  }
};

/**
 * Прикрепляет, изменяет или открепляет одну связь материала; остальные связи сохраняются.
 * Отказы: DocumentRelationError (ALREADY_EXISTS, RELATION_NOT_FOUND), DocumentConflictError.
 */
export const relateMaterial = async (
  projectId: string,
  material: MaterialRevision,
  change: MaterialRelationChange,
  requestId: string,
): Promise<EntitySaved> => {
  try {
    const response = await getProjectApi(projectId).entities.relateDocument({
      ref: material.id,
      ifRevision: material.revision,
      action: change.action,
      target: `${change.target.kind}:${change.target.id}`,
      type: change.type,
      ...(change.description === undefined ? {} : { description: change.description }),
      ...(change.nextType === undefined ? {} : { nextType: change.nextType }),
      requestId,
    });
    return entitySavedSchema.parse(response.data);
  } catch (failure) {
    return throwDocumentFailure(failure);
  }
};

/** Читает материалы, прикреплённые непосредственно к сущности любого из 11 видов. */
export const getEntityMaterialsPage = async (
  projectId: string,
  ref: string,
  archived: boolean | null,
  offset: number,
  version: string | undefined,
): Promise<EntityMaterialsPage> => {
  try {
    const response = await getProjectApi(projectId).entities.getEntityDocuments({
      ref,
      offset,
      limit: ENTITY_MATERIALS_LIMIT,
      ...(archived === null ? {} : { archived: archived ? "true" : "false" }),
      ...(version === undefined ? {} : { version }),
    });
    return entityDocumentsPageSchema.parse(response.data);
  } catch (failure) {
    return throwDocumentFailure(failure);
  }
};
