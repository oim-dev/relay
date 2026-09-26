import { z } from "zod";

/** Переход удаляет весь автоматический аудит; адресные разрешения больше не нужны. */
export const storageMigrationOptionsSchema = z.strictObject({});
export type StorageMigrationOptions = z.infer<typeof storageMigrationOptionsSchema>;
