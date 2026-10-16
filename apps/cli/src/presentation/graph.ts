import { entityAddress, graphQuerySchema } from "@relay/core/domain/entity-graph";
import type {
  GraphPage,
  GraphQuery,
  GraphSaved,
  FullContext,
  GraphNode,
  EntityRef,
} from "@relay/core/domain/entity-graph";
import { safeText } from "./text.js";
import { renderMarkdown } from "./markdown.js";
import { wrap } from "./layout.js";
import { defaultTextOptions, type TextOptions } from "./theme.js";
import {
  cardText,
  commandText,
  emptyText,
  listText,
  receiptText,
  type OutputCommand,
} from "./common.js";

export interface GraphNavigation {
  read?: (node: GraphNode) => string;
  descriptions?: (ref: EntityRef) => string | undefined;
  boundary?: (ref: EntityRef) => string;
}

/** Полное название — только в словаре; рёбра и пути используют короткие ключи. */
function nodesText(
  nodes: readonly GraphNode[],
  options: TextOptions,
  _navigation: GraphNavigation,
): string {
  return (
    nodes
      .map((node) => {
        return [
          listText(
            {
              title: "",
              items: [
                {
                  key: node.key,
                  title: node.title,
                  details: [
                    `Вид: ${node.ref.kind} · ревизия: ${node.revision}${node.status ? ` · состояние: ${node.status}` : ""}`,
                  ],
                  fields: [["Постоянный адрес", entityAddress(node.ref), "opaque"]],
                },
              ],
            },
            options,
          ),
        ].join("\n");
      })
      .join("\n\n") ||
    emptyText("Сущностей на этой странице нет; отношения читаются отдельной коллекцией.", options)
  );
}

/** Каждое ребро выводится отдельно: параллельные отношения и циклы не сворачиваются. */
function relationshipsText(
  edges: readonly (FullContext["edges"][number] & { description?: string })[],
  labels: ReadonlyMap<string, string>,
  options: TextOptions,
): string {
  return (
    edges
      .map((edge) =>
        cardText(
          {
            title: "",
            fields: [
              ["ID отношения", edge.id, "opaque"],
              [
                "Связь",
                `${labels.get(entityAddress(edge.from)) ?? entityAddress(edge.from)} ── ${edge.type} → ${labels.get(entityAddress(edge.to)) ?? entityAddress(edge.to)}`,
                "opaque",
              ],
              ["Ревизия", edge.revision],
            ],
            sections: edge.description
              ? [
                  {
                    title: "Пользовательский Markdown",
                    body: `Начало пояснения ${safeText(edge.id)}\n${renderMarkdown(edge.description, options)}\nКонец пояснения ${safeText(edge.id)}`,
                  },
                ]
              : [],
          },
          options,
        ),
      )
      .join("\n\n") || emptyText("Сохранённых отношений в этой выборке нет.", options)
  );
}

/** Полная компонента — граф связей, а не полные тексты требований и задач. */
export function fullContextText(
  context: FullContext,
  options: TextOptions,
  commands: readonly OutputCommand[] = [],
  navigation: GraphNavigation = {},
): string {
  const labels = new Map(context.nodes.map((node) => [entityAddress(node.ref), node.key]));
  return cardText(
    {
      title: `Полный контекст — ${labels.get(entityAddress(context.root)) ?? entityAddress(context.root)}`,
      fields: [
        ["Обход", "В обоих направлениях, вся достижимая компонента"],
        ["Полнота графа", context.complete ? "Подтверждена" : "Не подтверждена"],
        ["Сущностей", context.nodes.length],
        ["Отношений", context.edges.length],
        ["Версия", context.version, "opaque"],
      ],
      sections: [
        {
          title: "Границы чтения",
          body: wrap(
            "Вся достижимая компонента без фильтров и страниц. Полные тексты сущностей не включены.",
            options.width,
          ),
        },
        {
          title: "Сущности",
          body: nodesText(context.nodes, options, navigation),
        },
        { title: "Сохранённые отношения", body: relationshipsText(context.edges, labels, options) },
        {
          title: "Пояснения отношений",
          body: wrap("Пояснения отношений не включены.", options.width),
        },
      ],
      commands,
    },
    options,
  );
}

export function graphText(
  page: GraphPage,
  query: GraphQuery,
  options: TextOptions,
  commands: readonly OutputCommand[] = [],
  navigation: GraphNavigation = {},
): string {
  const selection = graphQuerySchema.parse(query);
  const labels = new Map(
    [...page.nodes, ...page.endpoints].map((node) => [entityAddress(node.ref), node.key]),
  );
  const paths = page.paths
    .filter((path) => path.edges.length > 0)
    .map((path) =>
      cardText(
        {
          title: "",
          fields: [
            ["Путь обхода", (path.keys ?? path.nodes.map(entityAddress)).join(" → "), "opaque"],
            ["ID отношений пути", path.edges.join(" → "), "opaque"],
          ],
        },
        options,
      ),
    )
    .join("\n\n");
  return cardText(
    {
      title: query.root ? `Связи — ${query.root}` : "Граф проекта",
      fields: [
        query.root ? ["Корень", query.root, "opaque"] : ["Корень", "Весь проект"],
        [
          "Направление обхода",
          { both: "Оба направления", outgoing: "Исходящие", incoming: "Входящие" }[
            query.direction ?? "both"
          ],
        ],
        ["Тип отношений", selection.type ?? "Все"],
        ["Поиск", selection.q ?? "Без фильтра"],
        ["Профиль", selection.profile === "context" ? "context (совместимое имя all)" : "all"],
        ["Глубина", selection.depth],
        ["Лимит каждого списка", selection.limit],
        ["Версия", page.version, "opaque"],
      ],
      sections: [
        {
          title: "Границы выборки",
          body: wrap(
            `Всего в выбранной области: ${page.totalNodes} сущностей, ${page.totalEdges} отношений.\nЛимит применяется отдельно к узлам и отношениям; общий счётчик страницы ниже — их сумма. Конец страниц не отменяет фильтры и глубину. Это не полный контекст.`,
            options.width,
          ),
        },
        {
          title: "Сущности страницы",
          body: nodesText(page.nodes, options, navigation),
        },
        ...(() => {
          const visible = new Set(page.nodes.map((node) => entityAddress(node.ref)));
          const endpoints = page.endpoints.filter((node) => !visible.has(entityAddress(node.ref)));
          return endpoints.length
            ? [
                {
                  title: "Концы отношений вне страницы узлов (не увеличивают счётчик страницы)",
                  body: nodesText(endpoints, options, navigation),
                },
              ]
            : [];
        })(),
        { title: "Отношения страницы", body: relationshipsText(page.edges, labels, options) },
        ...(paths
          ? [
              {
                title: "Почему включено — пути обхода, не направления сохранённых рёбер",
                body: paths,
              },
            ]
          : []),
        ...(page.depthLimited
          ? [
              {
                title: "Достигнута граница глубины",
                body: page.boundary.length
                  ? [
                      wrap(
                        "В выборке есть граница глубины. Продолжить ограниченный обход от граничного узла:",
                        options.width,
                      ),
                      ...page.boundary.map((ref) =>
                        [
                          safeText(
                            `${labels.get(entityAddress(ref)) ?? entityAddress(ref)} · ${entityAddress(ref)}`,
                          ),
                          navigation.boundary ? commandText(navigation.boundary(ref), options) : "",
                        ]
                          .filter(Boolean)
                          .join("\n"),
                      ),
                    ].join("\n")
                  : wrap(
                      "В выборке есть граница глубины; на этой странице граничных узлов нет. Конец страниц не доказывает полноту контекста.",
                      options.width,
                    ),
              },
            ]
          : []),
      ],
      commands,
    },
    options,
  );
}

/** Квитанция не выдаёт число возвращённых ID за число реально изменённых рёбер. */
export function graphSavedText(
  saved: GraphSaved,
  options: TextOptions = defaultTextOptions,
  commands: readonly OutputCommand[] = [],
): string {
  return receiptText(
    {
      title: "Пакет операций над диагностическими связями применён",
      fields: [
        ["Ревизия графа", saved.revision],
        ["Версия", saved.version, "opaque"],
        ["ID в ответе", saved.ids.length],
        ...saved.ids.map((id) => ["ID отношения", id, "opaque"] as const),
        ["Идентификатор запроса", saved.requestId, "opaque"],
        [
          "Границы",
          "Предметные линки и статусы этим действием не изменяются. Проверьте сохранённые отношения.",
        ],
      ],
      commands,
    },
    options,
  );
}
