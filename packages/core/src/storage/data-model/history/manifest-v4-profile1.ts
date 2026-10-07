/**
 * Замороженный parser manifest Relay 0.9.2 (профиль 1: формат 4 без dataModelVersion).
 *
 * Происхождение: тег v0.9.2 (6840a13a6c6c86600a489460418f8cdac18395c4),
 * `git show v0.9.2:packages/contracts/src/storage.ts` — `storageManifestSchema`.
 * Копия не импортирует изменяемые схемы Contracts. Используется историческим reader и тестом,
 * доказывающим, что прежний строгий parser отвергает manifest нового профиля.
 */
import { z } from "zod";

export const manifestV4Profile1Schema = z.strictObject({
  format: z.literal("relay-entities"),
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  productId: z.string().optional(),
});
export type ManifestV4Profile1 = z.output<typeof manifestV4Profile1Schema>;
