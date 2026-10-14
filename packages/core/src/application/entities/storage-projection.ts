import { Workspace } from "../../storage/workspace.js";
import { readEntityCatalog, entitySummary } from "./catalog.js";
import { storageCardSchema } from "@relay/contracts/storage";
import { entityAddress } from "@relay/contracts/entities/graph";
import { invariant } from "../../shared/errors.js";
import { configSchema } from "../../domain/config.js";
import type { MigrationIndexProjectionInput } from "../../storage/data-model/registry.js";
import { z } from "zod";

const recordIndexEntry = z.object({ deleted: z.boolean() });

/** Проектор миграции читает подготовленный итог, не открывая прежнюю базу и не публикуя вторую запись. */
export async function refreshMigrationEntityCards(
  input: MigrationIndexProjectionInput,
): Promise<void> {
  const workspace = new Workspace(
    input.configPath,
    input.session.store.root,
    configSchema.parse(input.config),
  );
  workspace.storageProductId = input.productId ?? undefined;
  // Каталог может добавить виртуальный пустой паспорт. Миграция проецирует только
  // действующие подготовленные записи и не создаёт сущности из таких строк каталога.
  const storedAddresses = new Set(
    (await input.session.indexEntries("records"))
      .filter(([, value]) => !recordIndexEntry.parse(value).deleted)
      .map(([address]) => address),
  );
  await workspace.inStorageSession(input.session, input.owned, () =>
    projectEntityCards(workspace, input.owned, storedAddresses),
  );
}

/** Вычисляемая готовность принадлежит продукту; индекс карточек обновляется до публикации операции. */
export async function refreshEntityCards(workspace: Workspace, owned: () => void): Promise<void> {
  return projectEntityCards(workspace, owned);
}

async function projectEntityCards(
  workspace: Workspace,
  owned: () => void,
  storedAddresses?: ReadonlySet<string>,
): Promise<void> {
  const session = workspace.storageSession;
  invariant(session, "STORAGE_SESSION_REQUIRED", "Нет сессии для обновления карточек", 5);
  const catalog = await readEntityCatalog(workspace, owned);
  for (const entry of catalog.entries) {
    const address = entityAddress(entry.ref);
    if (storedAddresses && !storedAddresses.has(address)) continue;
    const raw = await session.indexGet("cards", address);
    invariant(raw, "STORAGE_INDEX_CORRUPT", `Не найдена текущая запись ${address}`, 5);
    const current = storageCardSchema.parse(raw);
    const card = {
      ...current,
      ...entitySummary(entry),
      key: entry.key,
      title: entry.title,
      revision: entry.revision,
      status: entry.status ?? "",
      aliases: entry.aliases,
      selectors: entry.selectors,
    };
    if (JSON.stringify(current) !== JSON.stringify(card))
      session.indexSet("cards", address, JSON.parse(JSON.stringify(card)));
  }
}
