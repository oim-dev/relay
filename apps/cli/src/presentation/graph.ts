import { entityAddress, graphQuerySchema } from "@relay/core/domain/entity-graph";
import type {
  GraphPage,
  GraphQuery,
  GraphSaved,
  FullContext,
} from "@relay/core/domain/entity-graph";
import { safeText } from "./text.js";
import { renderMarkdown } from "./markdown.js";
import { wrap } from "./layout.js";
import { defaultTextOptions, type TextOptions } from "./theme.js";
import { cardText, emptyText, listText, receiptText, type OutputCommand } from "./common.js";

const meanings: Record<string, string> = {
  "depends-on": "зависит от",
  blocks: "блокирует",
  related: "связано с",
  parent: "родитель",
  child: "подзадача",
  references: "ссылается на",
  documents: "документирует",
  implements: "реализует",
  "part-of": "часть",
  contains: "содержит",
};

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
            title: `${labels.get(entityAddress(edge.from)) ?? entityAddress(edge.from)} ── ${meanings[edge.type] ?? edge.type} → ${labels.get(entityAddress(edge.to)) ?? entityAddress(edge.to)}`,
            fields: [
              ["Тип", edge.type],
              ["ID отношения", edge.id],
              ["Ревизия", edge.revision],
            ],
            sections: edge.description
              ? [{ title: "Пояснение", body: renderMarkdown(edge.description, options) }]
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
): string {
  const labels = new Map(
    context.nodes.map((node) => [entityAddress(node.ref), `${node.key} — ${node.title}`]),
  );
  return cardText(
    {
      title: `Полный контекст — ${labels.get(entityAddress(context.root)) ?? entityAddress(context.root)}`,
      fields: [
        ["Обход", "В обоих направлениях, вся достижимая компонента"],
        ["Полнота графа", context.complete ? "Подтверждена" : "Не подтверждена"],
        ["Сущностей", context.nodes.length],
        ["Отношений", context.edges.length],
        ["Версия", context.version],
      ],
      sections: [
        {
          title: "Границы чтения",
          body: wrap(
            "Без фильтров, ограничения глубины и страниц. Карточки контекста не заменяют полные тексты требований, документов и задач: прочитайте нужные записи адресно. Направление каждого отношения сохранено; достижимость не означает готовность или выполнение.",
            options.width,
          ),
        },
        {
          title: "Сущности",
          body: listText(
            {
              title: "",
              items: context.nodes.map((node) => ({
                key: node.key,
                title: node.title,
                details: [
                  `Вид: ${node.ref.kind} · ревизия: ${node.revision}${node.status ? ` · состояние: ${node.status}` : ""}`,
                  `Постоянный адрес: ${entityAddress(node.ref)}`,
                ],
              })),
            },
            options,
          ),
        },
        { title: "Сохранённые отношения", body: relationshipsText(context.edges, labels, options) },
        {
          title: "Пояснения отношений",
          body: wrap(
            "Ответ context не содержит описаний отношений. Для их чтения используйте inspect graph list; полные тексты сущностей читайте предметными get.",
            options.width,
          ),
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
): string {
  const selection = graphQuerySchema.parse(query);
  const labels = new Map(
    [...page.nodes, ...page.endpoints].map((node) => [
      entityAddress(node.ref),
      `${node.key} — ${node.title}`,
    ]),
  );
  const paths = page.paths
    .filter((path) => path.edges.length > 0)
    .map((path) =>
      wrap(
        `${safeText(labels.get(entityAddress(path.target)) ?? entityAddress(path.target))}: ${(path.keys ?? path.nodes.map(entityAddress)).map(safeText).join(" → ")}\nID отношений пути: ${path.edges.map(safeText).join(", ")}`,
        options.width,
      ),
    )
    .join("\n\n");
  return cardText(
    {
      title: query.root ? `Связи — ${query.root}` : "Граф проекта",
      fields: [
        ["Корень", query.root ?? "Весь проект"],
        [
          "Направление",
          { both: "Оба направления", outgoing: "Исходящие", incoming: "Входящие" }[
            query.direction ?? "both"
          ],
        ],
        ["Тип отношений", selection.type ?? "Все"],
        ["Поиск", selection.q ?? "Без фильтра"],
        ["Профиль", selection.profile === "context" ? "context (совместимое имя all)" : "all"],
        ["Глубина", selection.depth],
        ["Лимит каждого списка", selection.limit],
        ["Версия", page.version],
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
          body: listText(
            {
              title: "",
              items: page.nodes.map((node) => ({
                key: node.key,
                title: node.title,
                details: [
                  `Вид: ${node.ref.kind} · ревизия: ${node.revision}${node.status ? ` · состояние: ${node.status}` : ""}`,
                  `Постоянный адрес: ${entityAddress(node.ref)}`,
                ],
              })),
              emptyMessage:
                "Сущностей на этой странице нет; отношения читаются отдельной коллекцией.",
            },
            options,
          ),
        },
        { title: "Отношения страницы", body: relationshipsText(page.edges, labels, options) },
        ...(paths
          ? [{ title: "Почему включено — объясняющие пути, не дерево всех связей", body: paths }]
          : []),
        ...(page.depthLimited
          ? [
              {
                title: "Достигнута граница глубины",
                body: wrap(
                  `Граничные сущности:\n${page.boundary.map((ref) => safeText(labels.get(entityAddress(ref)) ?? entityAddress(ref))).join("\n")}\nДля всей достижимой компоненты используйте inspect graph context с выбранным корнем.`,
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
        ["Версия", saved.version],
        ["ID в ответе", saved.ids.length],
        ["Отношения", saved.ids.join(", ") || "Нет ID в ответе"],
        ["Идентификатор запроса", saved.requestId],
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
