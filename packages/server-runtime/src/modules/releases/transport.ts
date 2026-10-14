import { z } from "zod";
import {
  releasesCompactQuerySchema,
  releasesCompactPageSchema,
  releaseCompositionCompactSchema,
  releaseCompositionCompactQuerySchema,
  saveReleaseByRefsSchema,
  updateReleaseByRefsSchema,
} from "@relay/contracts/releases";

export const releasePreviewProjectionQuerySchema = z.strictObject({
  projection: releaseCompositionCompactQuerySchema.shape.projection,
});
export const releaseTransportSchemas = {
  ReleasesCompactQuery: releasesCompactQuerySchema,
  ReleasesCompactPage: releasesCompactPageSchema,
  ReleaseCompositionCompactQuery: releaseCompositionCompactQuerySchema,
  ReleaseCompositionCompact: releaseCompositionCompactSchema,
  ReleasePreviewProjectionQuery: releasePreviewProjectionQuerySchema,
  SaveReleaseByRefs: saveReleaseByRefsSchema,
  UpdateReleaseByRefs: updateReleaseByRefsSchema,
};
