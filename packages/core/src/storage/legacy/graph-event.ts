import { z } from "zod";
import { graphEdgeSchema } from "@relay/contracts/entities/graph";
import { actorSchema, timestampSchema } from "@relay/contracts/primitives";

/** Только декодирование прежнего формата графа и его незавершённых намерений. */
export const graphEventSchema = z.strictObject({
  action: z.enum(["add", "update", "remove"]),
  edge: graphEdgeSchema,
  actor: actorSchema,
  at: timestampSchema,
  revision: z.number().int().positive(),
});
export type GraphEvent = z.infer<typeof graphEventSchema>;
