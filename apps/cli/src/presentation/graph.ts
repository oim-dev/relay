import Table from "cli-table3";
import { entityAddress } from "@relay/core/domain/entity-graph";
import type {
  GraphPage,
  GraphQuery,
  GraphSaved,
  FullContext,
} from "@relay/core/domain/entity-graph";
import { safeText } from "./text.js";
import { renderMarkdown } from "./markdown.js";
import { wrap } from "./layout.js";
import type { TextOptions } from "./theme.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

/** Плоское представление сохраняет все ветвления и циклы, не превращая граф в дерево. */
export function fullContextText(context: FullContext, options: TextOptions): string {
  const labels = new Map(
    context.nodes.map((node) => [
      entityAddress(node.ref),
      `${node.key} [${entityAddress(node.ref)}]`,
    ]),
  );
  const root = context.nodes.find(
    (node) => entityAddress(node.ref) === entityAddress(context.root),
  );
  const rows = context.nodes.map((node) => [
    node.key,
    entityAddress(node.ref),
    node.title,
    node.status || "—",
  ]);
  const table = new Table({
    head: ["Ключ", "Постоянный адрес", "Сущность", "Состояние"],
    wordWrap: true,
    colWidths: [24, 30, Math.max(20, options.width - 74), 15],
  });
  table.push(...rows.map((row) => row.map(safeText)));
  const nodes =
    options.width >= 110
      ? table.toString()
      : rows
          .map((row) =>
            wrap(
              `${safeText(row[0]!)} · ${safeText(row[1]!)}\n${safeText(row[2]!)} · ${safeText(row[3]!)}`,
              options.width,
            ),
          )
          .join("\n\n");
  const edges = context.edges
    .map((edge) =>
      wrap(
        `${safeText(labels.get(entityAddress(edge.from)) ?? entityAddress(edge.from))} ── ${safeText(edge.type)} → ${safeText(labels.get(entityAddress(edge.to)) ?? entityAddress(edge.to))}\nСвязь ${safeText(edge.id)} · ревизия ${edge.revision}`,
        options.width,
      ),
    )
    .join("\n\n");
  return [
    `Полный контекст ${safeText(root?.key ?? entityAddress(context.root))}`,
    nodes,
    "Сохранённые отношения",
    edges || "Связей нет: в контексте только исходная сущность.",
    `Граф прочитан полностью: ${context.nodes.length} сущностей, ${context.edges.length} связей.`,
    `Версия: ${context.version}`,
  ].join("\n\n");
}

/** Показывает сущности, направления и объясняющие пути, не печатая внутренние объекты. */
export function graphText(page: GraphPage, query: GraphQuery, options: TextOptions): string {
  const title = query.root ? `Связи ${safeText(query.root)}` : "Граф проекта";
  const labels = new Map(
    [...page.nodes, ...page.endpoints].map((node) => [
      entityAddress(node.ref),
      `${node.key} · ${node.title}`,
    ]),
  );
  const rows = page.nodes.map((node) => [node.key, node.ref.kind, node.title, node.status || "—"]);
  const table = new Table({
    head: ["Ключ", "Вид", "Сущность", "Состояние"],
    wordWrap: true,
    colWidths: [30, 20, Math.max(20, options.width - 72), 17],
  });
  table.push(...rows.map((row) => row.map(safeText)));
  const nodes =
    rows.length === 0
      ? "Сущностей нет."
      : options.width < 110
        ? rows.map((row) => wrap(row.map(safeText).join(" · "), options.width)).join("\n\n")
        : table.toString();
  const edges = page.edges
    .map((edge) =>
      [
        wrap(
          `${safeText(labels.get(entityAddress(edge.from)) ?? entityAddress(edge.from))} ── ${safeText(edge.type)} → ${safeText(labels.get(entityAddress(edge.to)) ?? entityAddress(edge.to))}`,
          options.width,
        ),
        `ID: ${edge.id} · Сохранённая связь Core · ревизия ${edge.revision}`,
        ...(edge.description ? [renderMarkdown(edge.description, options)] : []),
      ].join("\n"),
    )
    .join("\n\n");
  const paths = page.paths
    .filter((path) => path.edges.length > 0)
    .map((path) =>
      wrap(
        `${safeText(labels.get(entityAddress(path.target)) ?? entityAddress(path.target))}: ${(path.keys ?? path.nodes.map(entityAddress)).map(safeText).join(" → ")}\nОснования: ${path.edges.join(", ")}`,
        options.width,
      ),
    )
    .join("\n\n");
  const next =
    page.nextOffset === null
      ? "Область прочитана полностью."
      : `Продолжение: relay-cli graph list ${Object.entries({
          ...query,
          offset: page.nextOffset,
          version: page.version,
        })
          .filter(([, value]) => value !== undefined)
          .map(
            ([key, value]) =>
              `--${key === "version" ? "snapshot-version" : key} ${quote(String(value))}`,
          )
          .join(" ")}`;
  return [
    title,
    nodes,
    "Отношения",
    edges || "Отношений нет.",
    ...(paths ? ["Почему включено", paths] : []),
    `Всего в выбранной области: ${page.totalNodes} сущностей, ${page.totalEdges} отношений.`,
    next,
    ...(page.depthLimited
      ? [
          "Достигнута глубина обхода. Продолжите от граничной сущности:",
          ...page.boundary.map((ref) => `relay-cli graph context ${quote(entityAddress(ref))}`),
        ]
      : []),
    `Версия: ${page.version}`,
  ].join("\n\n");
}

/** Квитанция сохраняет идентификаторы и данные безопасного повтора. */
export function graphSavedText(saved: GraphSaved): string {
  return `Связи сохранены: ${saved.ids.join(", ")}\nРевизия: ${saved.revision}\nВерсия: ${saved.version}\nКлюч повтора: ${safeText(saved.requestId)}`;
}
