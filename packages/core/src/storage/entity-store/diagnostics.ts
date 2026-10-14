import { z } from "zod";
import type { EntityRef } from "@relay/contracts/entities/graph";
import { AppError, asAppError } from "../../shared/errors.js";
import type { EntityStorageRegistry } from "./registry.js";

/** Адрес берётся из ожидаемого пути, даже если JSON или идентичность записи повреждены. */
export function fileRef(registry: EntityStorageRegistry, path: string): EntityRef | undefined {
  const parts = path.split("/");
  if (!["entities", "relations"].includes(parts[0] ?? "")) return undefined;
  const codec = registry.definitions().find((entry) => entry.collection === parts[1]);
  const id = parts[2]?.replace(/\.json$/, "");
  return codec && id ? { kind: codec.kind, id } : undefined;
}

/** Не превращает ошибку схемы файла в IO_ERROR и не теряет вложенные поля причины. */
export function fileError(error: unknown, path: string, ref?: EntityRef): AppError {
  const failure =
    error instanceof z.ZodError
      ? new AppError("INVALID_DATA", "Сохранённая запись не соответствует схеме", 5, {
          issues: error.issues,
        })
      : asAppError(error);
  const details = failure.details;
  return new AppError(failure.code, failure.message, failure.exitCode, {
    path,
    ...(ref ? { ref } : {}),
    ...(details && typeof details === "object" && !Array.isArray(details)
      ? details
      : details === undefined
        ? {}
        : { cause: details }),
  });
}
