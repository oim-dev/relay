export { useProduct } from "./hooks/use-product.hook";
export { getProduct, saveProduct, productError } from "./adapters/product.adapter";
export { ProductNotFoundError } from "./errors/product-errors";
export type { ProductState, ProductLink, ProductInput, ProductCommand } from "./types/product.type";
export { PRODUCT_LINK_SCHEMA, APPLICATION_SLUG_SCHEMA } from "./config/product.schema";
export {
  useProductEntities,
  useProductEntity,
  useProductTargetSearch,
} from "./hooks/use-product-entities.hook";
export { getProductTargetOptions } from "./helpers/context-options";
export { updateProductImplementation } from "./adapters/product-entities.adapter";
export { findProductEntry, productEntityPath } from "./helpers/product-address";
export type {
  ProductEntity,
  ProductEntitySummary,
  ProductEntitiesQuery,
  ImplementationChange,
} from "./types/product-entity.type";
export { ProductKey } from "./ui/product-key/product-key";
export { PRODUCT_TARGET_LINK_SCHEMA } from "./config/product.schema";
export type { ProductTargetLink } from "./types/product-entity.type";
export { useFeatureExpansion } from "./hooks/use-feature-expansion.hook";
export { PRODUCT_STATUS_LABELS } from "./config/product-status";
export { useProductTargetPreviews } from "./hooks/use-product-target-previews.hook";
export type { ProductTargetPreview } from "./types/product-target-preview.type";
