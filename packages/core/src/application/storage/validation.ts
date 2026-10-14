import { AppError, asAppError, invariant } from "../../shared/errors.js";
import type { Workspace } from "../../storage/workspace.js";
import {
  EntityStore,
  StorageSession,
  withRecordDetails,
} from "../../storage/entity-store/store.js";
import { fileError, fileRef } from "../../storage/entity-store/diagnostics.js";
import { readOwned } from "../../storage/entity-store/relations.js";
import { digest, EMPTY_STATE, jsonValue } from "../../storage/entity-store/format.js";
import { forgetStorageSegments } from "../../storage/entity-store/hash-index.js";
import { productionTransitionRegistry } from "../../storage/data-model/transitions/index.js";
import { readStorageSource, resolveSourceTarget } from "../../storage/data-model/source/reader.js";
import { withMaintenanceLock } from "../../storage/data-model/source/maintenance-lock.js";
import { requireCurrentProfile } from "../../storage/data-model/manifest.js";
import type { StoredRecord } from "@relay/contracts/storage";
import { checkStoredIndexes } from "./index-validation.js";

export type ValidationIssue = {
  code: string;
  message: string;
  details?: unknown;
  checks?: string[];
};

/** Причина и адрес, а не только код: одинаковые повреждения разных файлов не объединяются. */
export class ValidationIssues {
  readonly values: ValidationIssue[] = [];
  private readonly byCause = new Map<string, ValidationIssue>();
  add(error: unknown, check: string) {
    const { code, message, details } = asAppError(error);
    const location =
      details && typeof details === "object" && !Array.isArray(details)
        ? (details as Record<string, unknown>)
        : undefined;
    const key = digest(
      jsonValue([
        code,
        location?.path ?? location?.ref ?? null,
        location?.slot ?? null,
        location?.index ?? null,
        location?.id ?? null,
        location?.issues ??
          location?.reason ??
          (code === "STORAGE_INDEX_STALE" && location?.path ? null : message),
        location ? null : (details ?? null),
      ]),
    );
    const prior = this.byCause.get(key);
    if (prior) {
      if (!prior.checks!.includes(check)) prior.checks!.push(check);
      if (location) prior.details = { ...location, ...(prior.details as object) };
      return;
    }
    const issue = { code, message, ...(details === undefined ? {} : { details }), checks: [check] };
    this.byCause.set(key, issue);
    this.values.push(issue);
  }
  async check<T>(name: string, operation: () => Promise<T>): Promise<T | undefined> {
    try {
      return await operation();
    } catch (error) {
      this.add(error, name);
      return undefined;
    }
  }
  assert() {
    invariant(
      this.values.length === 0,
      "VALIDATION_FAILED",
      "Обнаружены нарушения целостности",
      5,
      this.values,
    );
  }
}

/** Полный файловый обход и предметные чтения держат один замок; публикации и recovery нет. */
export async function withWorkspaceValidation<T>(
  workspace: Workspace,
  operation: (issues: ValidationIssues, owned: () => void) => Promise<T>,
): Promise<T> {
  const target = await resolveSourceTarget(workspace.configPath);
  return withMaintenanceLock(
    { root: target.root, storageRoot: target.legacyStorage },
    async (owned) => {
      const registry = productionTransitionRegistry();
      const source = await readStorageSource(await resolveSourceTarget(workspace.configPath), {
        registry,
        owned,
      });
      if (source.manifest) requireCurrentProfile(source.manifest);
      else if (source.blockers.length) {
        const { code, message, ...details } = source.blockers[0]!;
        throw new AppError(code, message, 5, details);
      }
      invariant(
        source.layout === "unified-4",
        "STORAGE_MIGRATION_REQUIRED",
        "Для проверки требуется актуальное хранилище",
        4,
      );
      invariant(
        source.pending.length === 0,
        "STORAGE_RECOVERY_REQUIRED",
        "Обнаружена незавершённая операция; проверка не выполняет восстановление",
        5,
        { path: "transactions/pending.json" },
      );
      const issues = new ValidationIssues();
      const store = await EntityStore.detached(target.root, registry.storage);
      // Проверяются физические страницы, не ранее прогретый кеш процесса.
      forgetStorageSegments(store.root);
      const state = await issues.check("storage.indexes", () => store.state());
      const session = new StorageSession(store, state ?? structuredClone(EMPTY_STATE), false);
      const invalid = new Set<string>();
      const records: StoredRecord[] = [];
      for (const entry of source.entries) {
        if (
          entry.area !== "config-root" ||
          entry.type !== "file" ||
          entry.category !== "entities" ||
          !entry.owner
        )
          continue;
        owned();
        try {
          const raw = await session.readFile(entry.path);
          withRecordDetails(registry.storage, raw, entry.path, () => {
            const record = registry.storage.validate(raw);
            invariant(
              registry.storage.path(record) === entry.path,
              "INVALID_DATA",
              "Запись находится на чужом ID-пути",
              5,
            );
            records.push(record);
          });
        } catch (error) {
          invalid.add(entry.path);
          issues.add(error, "storage.entities");
        }
      }
      for (const entry of source.entries) {
        if (
          entry.area !== "config-root" ||
          entry.type !== "file" ||
          entry.category !== "relations" ||
          !entry.owner ||
          entry.path.split("/").length !== 3
        )
          continue;
        owned();
        try {
          await readOwned(session, fileRef(registry.storage, entry.path)!, false);
        } catch (error) {
          const failure = fileError(error, entry.path, fileRef(registry.storage, entry.path));
          invalid.add((failure.details as { path: string }).path);
          issues.add(failure, "storage.relations");
        }
      }
      // Заменяем обезличенную schema-причину первичной ошибкой с полями того же файла.
      // Reader не принимает неразобранную цель за отсутствующую; независимые разрывы остаются.
      for (const blocker of [...source.blockers, ...source.indexIssues]) {
        if (blocker.path && invalid.has(blocker.path)) continue;
        const { code, message, ...details } = blocker;
        issues.add(
          new AppError(code, message, 5, {
            ...details,
            ...(details.path && fileRef(registry.storage, details.path)
              ? { ref: fileRef(registry.storage, details.path) }
              : {}),
          }),
          "storage.integrity",
        );
      }
      if (state) {
        const expected = await issues.check("storage.indexes", () =>
          session.indexEntries("file-hashes"),
        );
        if (expected) {
          const paths = new Set(expected.map(([path]) => path));
          for (const entry of source.entries)
            if (
              entry.area === "config-root" &&
              entry.type === "file" &&
              ["entities", "relations", "keyspaces"].includes(entry.category)
            )
              paths.add(entry.path);
          const hashes = new Map(expected);
          for (const path of paths) {
            if (invalid.has(path)) continue;
            await issues.check("storage.file-hashes", async () => {
              const raw = await session.readFile(path);
              invariant(
                raw !== null && digest(raw) === hashes.get(path),
                "STORAGE_INDEX_STALE",
                "Постоянный файл расходится с индексом. Выполните storage reindex",
                4,
                {
                  path,
                  ...(fileRef(registry.storage, path)
                    ? { ref: fileRef(registry.storage, path) }
                    : {}),
                },
              );
            });
          }
        }
      }
      if (source.warnings.some((warning) => warning.path === "runtime/index-stale.json"))
        issues.add(
          new AppError(
            "STORAGE_INDEX_STALE",
            "Обнаружена отметка внешних изменений. Выполните storage reindex",
            4,
            { path: "runtime/index-stale.json" },
          ),
          "storage.indexes",
        );
      // Повреждение индексов не останавливает независимую проверку всех постоянных файлов,
      // но по таким индексам нельзя строить успешный предметный срез.
      if (!state) issues.assert();
      workspace.storageProductId = source.manifest?.productId;
      if (issues.values.length === 0) {
        const mismatches = await issues.check("storage.indexes", () =>
          checkStoredIndexes(workspace, session, records, owned),
        );
        for (const mismatch of mismatches ?? []) issues.add(mismatch, "storage.indexes");
      }
      const result = await workspace.inStorageSession(session, owned, () =>
        operation(issues, owned),
      );
      owned();
      issues.assert();
      return result;
    },
  );
}
