import { z } from "zod";

/** Черновик хранит исходную ревизию и корреляцию запроса, но не гарантирует безопасный повтор. */
export const TASK_DRAFT_SCHEMA = z.object({
  values: z.object({ title: z.string(), description: z.string() }),
  revision: z.number(),
  request: z.object({ fingerprint: z.string(), id: z.string() }).optional(),
});
