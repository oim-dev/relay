/**
 * Замороженная схема WAL обычной операции Relay 0.9.2 (`intentSchema`, schemaVersion 1).
 *
 * Происхождение: тег v0.9.2 (6840a13a6c6c86600a489460418f8cdac18395c4),
 * `git show v0.9.2:packages/core/src/storage/entity-store/transaction.ts` (`intentSchema`)
 * и `.../entity-store/format.ts` (`hashSchema`, `relativePathSchema`).
 * Строгий `z.literal(1)` означает, что 0.9.2 отвергает WAL любой другой версии до записи;
 * поэтому WAL миграции обязан иметь иную версию. Схема копируется, а не импортируется.
 */
import { z } from "zod";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const relativePathSchema = z
  .string()
  .refine(
    (path) =>
      /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(path) &&
      path.split("/").every((part) => part !== "." && part !== ".."),
    "Ожидается безопасный относительный путь",
  );

export const intentV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  changes: z.array(
    z.strictObject({
      path: relativePathSchema,
      before: hashSchema.nullable(),
      after: z.json().nullable(),
    }),
  ),
});
export type IntentV1 = z.output<typeof intentV1Schema>;
