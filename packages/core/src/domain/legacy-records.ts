import { z } from "zod";
import { actorSchema, timestampSchema } from "@relay/contracts/primitives";
import { boardTaskRecordSchema as task, boardTaskSavedSchema } from "@relay/contracts/entities/board-task";
import { productRecordSchema as product, productSavedSchema } from "@relay/contracts/entities/product";
import { productImplementationSchema as implementation } from "@relay/contracts/entities/product-implementation";
import { boardSchema as board } from "@relay/contracts/entities/board";
import { storedProjectSettingsSchema as settings } from "@relay/contracts/entities/project-settings";

/** Локальные формы прежних репозиториев. На диск v3 эти поля не проецируются. */
const event = z.strictObject({ revision: z.number().int().positive(), actor: actorSchema, at: timestampSchema, action: z.string() });
const requests = z.record(z.string(), z.strictObject({ hash: z.string(), result: z.strictObject({ id: z.string(), key: z.string(), revision: z.number().int().nonnegative() }) }));
const productAudit = {
  events: z.array(event.omit({ action: true })),
  requests: z.record(z.string(), z.strictObject({ hash: z.string(), result: productSavedSchema })),
};
export const boardTaskRecordSchema = task.extend({ events: z.array(event).optional(), requests: z.record(z.string(), z.strictObject({ hash: z.string(), result: boardTaskSavedSchema })) });
export type BoardTaskRecord = z.infer<typeof boardTaskRecordSchema>;
export const productRecordSchema = product.extend(productAudit);
export type ProductRecord = z.infer<typeof productRecordSchema>;
export const productImplementationSchema = implementation.extend(productAudit);
export type ProductImplementation = z.infer<typeof productImplementationSchema>;
export const storedImplementationSchema = productImplementationSchema.extend({
  version: z.literal(3), fields: productImplementationSchema.shape.fields.extend({ description: z.array(z.string().refine((line) => !line.includes("\n"))) }),
});
export function encodeImplementation(record: ProductImplementation) {
  return storedImplementationSchema.parse({ ...record, version: 3, fields: { ...record.fields, description: record.fields.description.split("\n") } });
}
export function decodeImplementation(value: unknown): ProductImplementation {
  const stored = storedImplementationSchema.parse(value);
  return productImplementationSchema.parse({ ...stored, version: 1, fields: { ...stored.fields, description: stored.fields.description.join("\n") } });
}
export const boardSchema = board.extend({ events: z.array(event).optional(), requests: requests.optional() });
export type Board = z.infer<typeof boardSchema>;
export const storedProjectSettingsSchema = settings.extend({ events: z.array(event).optional(), requests: requests.optional() });
