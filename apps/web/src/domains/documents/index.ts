export { DOCUMENT_INPUT_SCHEMA } from "./types/document.type";
export type {
  DocumentInput,
  KnowledgeDocument,
  DocumentRelation,
  DocumentSection,
  DocumentEntity,
  LibrarySettings,
  MaterialFormat,
  MaterialView,
  MaterialSort,
  MaterialCatalogFilters,
  MaterialCatalogPage,
  MaterialPropertyChanges,
  MaterialFacets,
  MaterialBulkOperation,
  MaterialBulkResult,
  MaterialBulkItem,
  MaterialRevision,
  MaterialRelationChange,
  MaterialTargetKind,
  EntityMaterialsPage,
  EntityMaterial,
} from "./types/document.type";
export {
  DOCUMENT_KINDS,
  DOCUMENT_KIND_OPTIONS,
  DOCUMENT_STATUSES,
  DOCUMENT_STATUS_OPTIONS,
  DOCUMENT_RELATION_TYPES,
  DOCUMENT_RELATION_TYPE_OPTIONS,
  MATERIAL_FORMATS,
  MATERIAL_FORMAT_OPTIONS,
  MATERIAL_TARGET_KINDS,
  MATERIAL_TAG_LIMITS,
} from "./config/documents.config";
export { useDocument, useLibrarySettings } from "./hooks/use-documents.hook";
export { useMaterialCatalog } from "./hooks/use-material-catalog.hook";
export { useMaterialFacets, ALL_MATERIALS_FILTERS } from "./hooks/use-material-facets.hook";
export { useEntityMaterials } from "./hooks/use-entity-materials.hook";
export { useMaterialMutations } from "./hooks/use-material-mutations.hook";
export { useEntityHref } from "./hooks/use-entity-href.hook";
export type { MaterialMutations } from "./hooks/use-material-mutations.hook";
export { normalizeMaterialTags } from "./helpers/normalize-material-tags";
export { MaterialTagsInput } from "./ui/material-tags-input/material-tags-input";
export type { MaterialTagsInputProps } from "./ui/material-tags-input/types/material-tags-input-props.type";
export {
  DocumentAccessError,
  DocumentConflictError,
  DocumentRelationError,
} from "./errors/document-errors";
export {
  getDocument,
  saveDocument,
  saveLibrarySections,
  updateMaterialProperties,
  documentEntityHref,
} from "./adapters/documents.adapter";
