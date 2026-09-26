import { join } from "node:path";
import type { GraphService } from "../../src/application/graph/service.js";
import { readJson, exists } from "../../src/storage/files.js";
import { legacyGraphSchema, graphStoredEventSchema, eventPath } from "../../src/storage/graph-format.js";

/** Только проверка сохранности старых файлов. Не возвращает публичный history API. */
export async function legacyGraphEvents(graph: GraphService, query: { id?: string | undefined } = {}) {
  const repository = graph.repository;
  const events = [];
  if (await exists(repository.legacyPath)) events.push(...legacyGraphSchema.parse(await readJson(repository.legacyPath)).events);
  else for (let sequence = 1; sequence <= (await repository.meta()).eventCount; sequence++)
    events.push(graphStoredEventSchema.parse(await readJson(join(repository.root, eventPath(sequence)))).event);
  const items = events.filter((event) => !query.id || event.edge.id === query.id)
    .map((event) => ({ ...event, edge: { ...event.edge, description: event.edge.description.join("\n") } }));
  return { items, total: items.length };
}
