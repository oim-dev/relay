import {
  serverCapabilitiesSchema,
  projectCatalogPageQuerySchema,
  projectCatalogPageSchema,
  projectRegistrationReceiptSchema,
  projectUnregistrationReceiptSchema,
} from "@relay/contracts/server-context";

/** Отдельные DTO новых операций; прежний ServerContextResponse не расширяется union. */
export const workspaceCatalogSchemas = {
  ServerCapabilities: serverCapabilitiesSchema,
  ProjectCatalogPageQuery: projectCatalogPageQuerySchema,
  ProjectCatalogPage: projectCatalogPageSchema,
  ProjectRegistrationReceipt: projectRegistrationReceiptSchema,
  ProjectUnregistrationReceipt: projectUnregistrationReceiptSchema,
};
