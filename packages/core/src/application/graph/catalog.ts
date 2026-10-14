import { entityAddress } from "../../domain/entity-graph.js";
import type { GraphNode } from "../../domain/entity-graph.js";
import type { Workspace } from "../../storage/workspace.js";
import { readEntityCatalog } from "../entities/catalog.js";
import type { EntityEntry } from "../entities/catalog.js";
import { readEntityCards } from "../entities/indexed-catalog.js";

/** Каталог предоставляет только адресуемые сущности; связи принадлежат хранилищу движка. */
export type GraphCatalog = {
  nodes: GraphNode[];
  aliases?: Readonly<Record<string, readonly string[]>>;
};

/** Источник вызывается только под блокировкой выбранного проекта. */
export type GraphCatalogProvider = () => Promise<GraphCatalog>;

/** Строгий источник мутации: проверяет весь предметный каталог, а не только концы нового ребра. */
export async function projectGraphCatalog(workspace: Workspace): Promise<GraphCatalog> {
  return workspace.locked(async (owned) =>
    graphCatalog((await readEntityCatalog(workspace, owned)).entries),
  );
}

/** Только чтение: использует опубликованные карточки, не ослабляя проверку мутации. */
export async function indexedProjectGraphCatalog(workspace: Workspace): Promise<GraphCatalog> {
  const entries = await workspace.locked(async (owned) => {
    const session = workspace.storageSession;
    // Вложенный writer ещё может не опубликовать каноническую проекцию готовности.
    return session && !session.changed
      ? readEntityCards(session)
      : (await readEntityCatalog(workspace, owned)).entries;
  });
  return graphCatalog(entries);
}

function graphCatalog(
  entries: readonly Pick<
    EntityEntry,
    "ref" | "key" | "title" | "revision" | "status" | "aliases"
  >[],
): GraphCatalog {
  return {
    nodes: entries
      .map((entry) => ({
        ref: entry.ref,
        key: entry.key,
        title: entry.title,
        revision: entry.revision,
        status: entry.status ?? "",
      }))
      .sort((a, b) => entityAddress(a.ref).localeCompare(entityAddress(b.ref))),
    aliases: Object.fromEntries(entries.map((entry) => [entityAddress(entry.ref), entry.aliases])),
  };
}
