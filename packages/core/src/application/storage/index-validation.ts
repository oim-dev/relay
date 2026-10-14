import type { StoredRecord } from "@relay/contracts/storage";
import { AppError } from "../../shared/errors.js";
import type { Workspace } from "../../storage/workspace.js";
import { StorageSession } from "../../storage/entity-store/store.js";
import { digest, EMPTY_STATE, jsonValue } from "../../storage/entity-store/format.js";
import { refreshEntityCards } from "../entities/storage-projection.js";

/** Сравнивает все производные проекции с файлами, не публикуя ни страницы, ни корни. */
export async function checkStoredIndexes(
  workspace: Workspace,
  current: StorageSession,
  records: readonly StoredRecord[],
  owned: () => void,
): Promise<AppError[]> {
  // Detached-хранилище не умеет публиковать: эта сессия — только вычисление ожиданий.
  const expected = new StorageSession(current.store, structuredClone(EMPTY_STATE), true);
  for (const [path, raw] of current.originals) {
    expected.originals.set(path, raw);
    if (raw !== null && /^(entities|relations|keyspaces)\//.test(path))
      expected.indexSet("file-hashes", path, digest(raw));
  }
  for (const record of records) await expected.indexRecord(record);
  await expected.rebuildRelations();
  await workspace.inStorageSession(expected, owned, () => refreshEntityCards(workspace, owned));
  const roots = await expected.snapshotRoots();
  const failures: AppError[] = [];
  for (const name of new Set([...Object.keys(roots), ...Object.keys(current.state.roots)])) {
    owned();
    const normalize = async (session: StorageSession) => {
      const entries = await session.indexEntries(name);
      // Физическое представление posting-списка (массив/дерево) не меняет его смысл.
      if (name === "adjacency")
        for (const entry of entries) entry[1] = (await session.postings(name, entry[0])).sort();
      return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    };
    const actual = await normalize(current);
    const wanted = await normalize(expected);
    if (digest(jsonValue(actual)) !== digest(jsonValue(wanted)))
      failures.push(
        new AppError(
          "STORAGE_INDEX_STALE",
          "Индекс расходится с постоянными данными. Выполните storage reindex",
          4,
          {
            path: ".indexes/state.json",
            index: name,
          },
        ),
      );
  }
  return failures;
}
