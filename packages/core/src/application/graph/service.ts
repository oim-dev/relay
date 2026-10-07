import {
  entityAddress,
  graphQuerySchema,
  graphMutationSchema,
  graphNodeSchema,
  graphEdgeSchema,
  fullContextQuerySchema,
} from "../../domain/entity-graph.js";
import type {
  EntityRef,
  GraphQuery,
  GraphPage,
  GraphMutation,
  GraphSaved,
  GraphEdge,
  GraphEvent,
  FullContext,
  FullContextQuery,
} from "../../domain/entity-graph.js";
import { parse, actorSchema } from "../../domain/validation.js";
import { invariant } from "../../shared/errors.js";
import { shortId } from "../../shared/ids.js";
import { GraphRepository } from "../../storage/graph.js";
import { graphDigest } from "../../storage/graph-format.js";
import type { GraphCurrent, GraphSummary } from "../../storage/graph-format.js";
import type { Workspace } from "../../storage/workspace.js";
import { projectGraphCatalog } from "./catalog.js";
import type { GraphCatalogProvider, GraphCatalog } from "./catalog.js";
import { resolveAddress } from "../entities/resolver.js";
import { AppError } from "../../shared/errors.js";
import {
  FullContextReader,
  FULL_CONTEXT_LIMITS,
  fullContextVersion,
} from "../../storage/entity-store/context.js";
import { refreshEntityCards } from "../entities/storage-projection.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { storageCardSchema } from "@relay/contracts/storage";

const versions = new Map<string, string>();
const contextReaders = new Map<string, FullContextReader>();
const versionOf = (catalogHash: string, fingerprint: string) =>
  graphDigest([catalogHash, fingerprint]);

/** Универсальные отношения: адресный индекс отделяет обход от чтения Markdown и истории. */
export class GraphService {
  readonly repository: GraphRepository;
  constructor(
    readonly workspace: Workspace,
    readonly catalog: GraphCatalogProvider = () => projectGraphCatalog(workspace),
    readonly validateMutation?: (catalog: GraphCatalog, edges: readonly GraphEdge[]) => void,
  ) {
    this.repository = new GraphRepository(workspace);
  }

  /**
   * Прежние адреса этапов плана не входят в каталог сущностей и не разрешаются как цель
   * новой связи, но остаются концами сохранённых связей (например, прикреплений документов).
   * Узел такого конца берётся из карточки записи совместимости, чтобы связь была видна.
   */
  private async addRelocatedEndpoints(
    nodes: z.infer<typeof graphNodeSchema>[],
    active: readonly Pick<GraphSummary, "from" | "to">[],
  ): Promise<void> {
    const session = this.workspace.storageSession;
    if (!session) return;
    const known = new Set(nodes.map((node) => entityAddress(node.ref)));
    const relocated = new Set(
      session.store.registry
        .definitions()
        .filter((definition) => definition.relocation)
        .map((definition) => definition.kind),
    );
    for (const edge of active)
      for (const ref of [edge.from, edge.to]) {
        const address = entityAddress(ref);
        if (known.has(address) || !relocated.has(ref.kind)) continue;
        const raw = await session.indexGet("cards", address);
        if (raw === undefined) continue;
        const card = storageCardSchema.parse(raw);
        nodes.push(
          graphNodeSchema.parse({
            ref: card.ref,
            key: card.key,
            title: card.title,
            revision: card.revision,
            status: card.status,
          }),
        );
        known.add(address);
      }
    nodes.sort((a, b) => entityAddress(a.ref).localeCompare(entityAddress(b.ref)));
  }

  private async snapshot(assertOwned: () => void) {
    const source = await this.catalog();
    const catalog = {
      nodes: source.nodes
        .map((node) => graphNodeSchema.parse(node))
        .sort((a, b) => entityAddress(a.ref).localeCompare(entityAddress(b.ref))),
    };
    const store = await this.repository.open(assertOwned);
    const references = catalog.nodes.map((node) => ({
      ...node,
      aliases: source.aliases?.[entityAddress(node.ref)] ?? [],
    }));
    await this.addRelocatedEndpoints(catalog.nodes, store.index.active);
    const catalogHash = graphDigest({
      ...catalog,
      ...(source.aliases ? { aliases: source.aliases } : {}),
    });
    // V1 остаётся читаемым без изменения постоянных связей и квитанций.
    const version = this.workspace.storageSession
      ? await fullContextVersion(this.workspace.storageSession)
      : store.legacy
        ? graphDigest([
            catalog.nodes,
            [
              ...store.legacy.edges.map((edge) =>
                graphEdgeSchema.parse({ ...edge, description: edge.description.join("\n") }),
              ),
            ].sort((a, b) => a.id.localeCompare(b.id)),
            store.meta.revision,
          ])
        : versionOf(catalogHash, store.index.fingerprint);
    const addresses = new Set(catalog.nodes.map((node) => entityAddress(node.ref)));
    invariant(
      addresses.size === catalog.nodes.length,
      "INVALID_DATA",
      "Повтор адреса сущности в каталоге",
      5,
    );
    if (versions.get(this.repository.root) !== version) {
      const ids = new Set<string>();
      for (const edge of store.index.active) {
        invariant(!ids.has(edge.id), "INVALID_DATA", "Повтор ID отношения", 5);
        ids.add(edge.id);
        invariant(
          addresses.has(entityAddress(edge.from)) && addresses.has(entityAddress(edge.to)),
          "INVALID_REFERENCE",
          `Отношение ${edge.id} ссылается на отсутствующую сущность`,
          4,
        );
      }
      versions.set(this.repository.root, version);
      if (versions.size > 8) versions.delete(versions.keys().next().value!);
    }
    return { catalog, catalogHash, store, version, addresses, references };
  }

  async read(input: GraphQuery = {}): Promise<GraphPage> {
    const query = parse(graphQuerySchema, input, "выборка графа");
    return this.workspace.locked(async (assertOwned) => {
      const { catalog, store, version, references } = await this.snapshot(assertOwned);
      invariant(
        query.version === undefined || query.version === version,
        "GRAPH_CHANGED",
        "Граф изменился. Начните чтение с первой страницы.",
        4,
      );
      // Полный адрес прежнего этапа открывает его связи для чтения; ключ и ID без вида —
      // нет: обычное разрешение адресов не выдаёт записи совместимости.
      const relocated = catalog.nodes.find((node) => entityAddress(node.ref) === query.root);
      const root =
        query.root === undefined
          ? undefined
          : relocated && !references.some((node) => entityAddress(node.ref) === query.root)
            ? relocated.ref
            : resolveAddress(references, query.root).ref;
      const byAddress = new Map(catalog.nodes.map((node) => [entityAddress(node.ref), node]));
      if (root)
        invariant(
          byAddress.has(entityAddress(root)),
          "NOT_FOUND",
          "Корневая сущность не найдена",
          3,
        );
      const neighbors = (address: string): GraphSummary[] =>
        store.index
          .related(address)
          .filter((edge) => !query.type || edge.type === query.type)
          .sort((a, b) => a.id.localeCompare(b.id));
      const paths = new Map<string, { target: EntityRef; nodes: EntityRef[]; edges: string[] }>();
      const boundary = new Set<string>();
      if (root) {
        const queue = [root];
        paths.set(entityAddress(root), { target: root, nodes: [root], edges: [] });
        for (let index = 0; index < queue.length; index++) {
          const current = queue[index]!;
          const address = entityAddress(current);
          const path = paths.get(address)!;
          for (const edge of neighbors(address)) {
            const outgoing = entityAddress(edge.from) === address;
            if (
              (query.direction === "incoming" && outgoing) ||
              (query.direction === "outgoing" && !outgoing)
            )
              continue;
            // Ответ не должен отдавать вызывающему изменяемую ссылку из кеша индекса.
            const next = { ...(outgoing ? edge.to : edge.from) };
            if (paths.has(entityAddress(next))) continue;
            if (path.edges.length >= query.depth) {
              boundary.add(address);
              continue;
            }
            paths.set(entityAddress(next), {
              target: next,
              nodes: [...path.nodes, next],
              edges: [...path.edges, edge.id],
            });
            queue.push(next);
          }
        }
      }
      const needle = query.q?.toLocaleLowerCase();
      const nodes = catalog.nodes.filter(
        (node) =>
          (!root || paths.has(entityAddress(node.ref))) &&
          (!needle ||
            `${entityAddress(node.ref)} ${node.key} ${node.title}`
              .toLocaleLowerCase()
              .includes(needle)),
      );
      const included = new Set(nodes.map((node) => entityAddress(node.ref)));
      const candidates = root
        ? [
            ...new Map(
              [...included].flatMap((address) => neighbors(address)).map((edge) => [edge.id, edge]),
            ).values(),
          ]
        : store.index.active;
      const edges = candidates
        .filter(
          (edge) =>
            (!query.type || query.type === edge.type) &&
            included.has(entityAddress(edge.from)) &&
            included.has(entityAddress(edge.to)),
        )
        .sort((a, b) => a.id.localeCompare(b.id));
      const pageNodes = nodes.slice(query.offset, query.offset + query.limit);
      const pageEdges: GraphEdge[] = [];
      for (const edge of edges.slice(query.offset, query.offset + query.limit))
        pageEdges.push(await this.repository.edge(edge.id, store));
      const endpoints = new Set(
        pageEdges.flatMap((edge) => [entityAddress(edge.from), entityAddress(edge.to)]),
      );
      const nextOffset = query.offset + query.limit;
      return {
        nodes: pageNodes,
        edges: pageEdges,
        endpoints: [...endpoints].map((address) => byAddress.get(address)!),
        paths: pageNodes.flatMap((node) => {
          const path = paths.get(entityAddress(node.ref));
          return path
            ? [{ ...path, keys: path.nodes.map((ref) => byAddress.get(entityAddress(ref))!.key) }]
            : [];
        }),
        totalNodes: nodes.length,
        totalEdges: edges.length,
        nextOffset: nextOffset < Math.max(nodes.length, edges.length) ? nextOffset : null,
        boundary: pageNodes
          .filter((node) => boundary.has(entityAddress(node.ref)))
          .map((node) => node.ref),
        depthLimited: boundary.size > 0,
        version,
      };
    });
  }

  /** Полный граф одной компоненты; чтение прежней базы совместимо и не выполняет миграцию. */
  async context(input: FullContextQuery): Promise<FullContext> {
    const query = parse(fullContextQuerySchema, input, "полный контекст сущности");
    return this.workspace.locked(async (owned) => {
      const session = this.workspace.storageSession;
      if (session) {
        let reader = contextReaders.get(session.store.root);
        if (!reader) {
          reader = new FullContextReader(session.store);
          contextReaders.set(session.store.root, reader);
          if (contextReaders.size > 8) contextReaders.delete(contextReaders.keys().next().value!);
        }
        return reader.readSnapshot(session, query.root);
      }
      const { catalog, store, version, references } = await this.snapshot(owned);
      const root = resolveAddress(references, query.root).ref;
      const byRef = new Map(catalog.nodes.map((node) => [entityAddress(node.ref), node]));
      const seen = new Set([entityAddress(root)]),
        ids = new Set<string>(),
        queue = [root];
      const edges: FullContext["edges"] = [];
      for (let index = 0; index < queue.length; index++)
        for (const summary of store.index.related(entityAddress(queue[index]!))) {
          if (ids.has(summary.id)) continue;
          const { id, type, from, to, revision } = await this.repository.edge(summary.id, store);
          ids.add(id);
          edges.push({ id, type, from, to, revision });
          for (const ref of [from, to])
            if (!seen.has(entityAddress(ref))) {
              seen.add(entityAddress(ref));
              queue.push(ref);
            }
          invariant(
            seen.size <= FULL_CONTEXT_LIMITS.nodes && edges.length <= FULL_CONTEXT_LIMITS.edges,
            "CONTEXT_TOO_LARGE",
            "Полный контекст превышает технический предел",
            4,
          );
        }
      const result: FullContext = {
        root,
        version,
        nodes: [...seen].sort().map((ref) => byRef.get(ref)!),
        edges: edges.sort((a, b) => a.id.localeCompare(b.id)),
        complete: true,
      };
      invariant(
        Buffer.byteLength(JSON.stringify(result)) <= FULL_CONTEXT_LIMITS.bytes,
        "CONTEXT_TOO_LARGE",
        "Полный контекст превышает бюджет ответа",
        4,
      );
      return result;
    });
  }

  async mutate(input: GraphMutation, defaultActor: string): Promise<GraphSaved> {
    const command = parse(graphMutationSchema, input, "изменение графа");
    const actor = parse(actorSchema, command.actor ?? defaultActor, "автор связи");
    return this.workspace.mutate("graph", command, actor, async (assertOwned) => {
      const key = graphDigest([actor, command.requestId]);
      const requestHash = graphDigest({ ...command, actor });
      // Только завершение уже начатого legacy workflow может прочитать старую квитанцию.
      // Новая запись её не создаёт; явная миграция затем удаляет прежний источник.
      if (this.workspace.recoveringDocumentLinks && !this.workspace.storageSession) {
        const receipt = await this.repository.receipt(key);
        if (receipt) {
          invariant(
            receipt.hash === requestHash,
            "DOCUMENT_LINK_RECOVERY_CONFLICT",
            "Прежняя квитанция не соответствует незавершённому прикреплению",
            5,
          );
          return receipt.result;
        }
      }
      const { catalog, catalogHash, store, version, addresses, references } =
        await this.snapshot(assertOwned);
      invariant(
        !store.legacy,
        "GRAPH_MIGRATION_REQUIRED",
        "Для новых записей выполните relay-cli --local graph migrate",
        4,
      );
      invariant(
        command.ifVersion === version,
        "GRAPH_CHANGED",
        "Граф изменился. Перечитайте его перед сохранением; введённые данные можно сохранить.",
        4,
      );
      const records = new Map<string, GraphCurrent>();
      const events: GraphEvent[] = [];
      const ids: string[] = [];
      const at = new Date().toISOString();
      const revision = store.meta.revision + 1;
      for (const operation of command.operations) {
        let record: GraphCurrent;
        if (operation.action === "add") {
          let from: EntityRef;
          let to: EntityRef;
          try {
            from = resolveAddress(references, operation.from).ref;
            to = resolveAddress(references, operation.to).ref;
          } catch (error) {
            if (error instanceof AppError && error.code === "ENTITY_NOT_FOUND")
              throw new AppError(
                "INVALID_REFERENCE",
                "Начало или конец связи не найдены в выбранном проекте",
                4,
              );
            throw error;
          }
          invariant(
            addresses.has(entityAddress(from)) && addresses.has(entityAddress(to)),
            "INVALID_REFERENCE",
            "Начало или конец связи не найдены в выбранном проекте",
            4,
          );
          let id = shortId();
          while (store.index.entries.has(id) || records.has(id)) id = shortId();
          record = {
            active: true,
            historyCount: 1,
            edge: {
              id,
              type: operation.type,
              from,
              to,
              description: operation.description,
              revision: 1,
              source: "graph",
              createdBy: actor,
              createdAt: at,
            },
          };
        } else {
          const existing =
            records.get(operation.id) ?? (await this.repository.get(operation.id, store));
          invariant(existing?.active, "NOT_FOUND", "Сохранённая активная связь не найдена", 3);
          if (this.workspace.storageSession) {
            const binding = await this.workspace.storageSession.indexGet("edges", operation.id);
            invariant(
              binding === undefined ||
                z.object({ slot: z.string() }).parse(binding).slot === "diagnostic",
              "RELATION_MANAGED",
              "Связь принадлежит предметному сценарию. Измените линк у документа, задачи или реализации; для восстановления выполните storage reconcile-relations.",
              4,
            );
          }
          record = {
            active: operation.action !== "remove",
            historyCount: existing.historyCount + 1,
            edge: {
              ...existing.edge,
              revision: existing.edge.revision + 1,
              ...(operation.action === "update" ? { description: operation.description } : {}),
            },
          };
        }
        records.set(record.edge.id, record);
        ids.push(record.edge.id);
        events.push({ action: operation.action, edge: record.edge, actor, at, revision });
      }
      if (this.validateMutation) {
        const edges: GraphEdge[] = [];
        for (const entry of store.index.active)
          if (!records.has(entry.id)) edges.push(await this.repository.edge(entry.id, store));
        edges.push(
          ...[...records.values()].filter((record) => record.active).map((record) => record.edge),
        );
        this.validateMutation(catalog, edges);
      }
      const result = await this.repository.commit(
        store,
        [...records.values()],
        events,
        key,
        requestHash,
        (fingerprint, revision) => ({
          ids,
          revision,
          version: versionOf(catalogHash, fingerprint),
          requestId: command.requestId,
        }),
        assertOwned,
        [],
      );
      // Предыдущий снимок и все изменённые концы уже проверены под той же блокировкой.
      versions.set(this.repository.root, result.version);
      return result;
    });
  }

  /** Явный локальный перенос v1 с сохранением исходника и всех квитанций. */
  async migrate() {
    return this.workspace.locked((assertOwned) => this.repository.migrate(assertOwned));
  }
  /** Восстанавливает производные индексы после внешнего редактирования или потери файлов. */
  async reindex() {
    if (await this.workspace.hasUnifiedStorage())
      return this.workspace.withEntityStorage(async (store, owned) => {
        await store.reindex(owned);
        const result = await store.transaction(owned, (session) =>
          this.workspace.inStorageSession(session, owned, async () => {
            await refreshEntityCards(this.workspace, owned);
            const snapshot = await this.repository.open(owned);
            return {
              revision: snapshot.meta.revision,
              edges: snapshot.index.active.length,
              events: snapshot.meta.eventCount,
            };
          }),
        );
        await rm(join(store.root, "runtime/index-stale.json"), { force: true });
        return result;
      });
    return this.workspace.locked(async (owned) => {
      const result = await this.repository.reindex(owned);
      if (this.workspace.storageSession) await refreshEntityCards(this.workspace, owned);
      return result;
    });
  }
}
