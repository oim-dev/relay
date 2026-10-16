import { cardText, listText, receiptText } from "./common.js";
import type { OutputField } from "./common.js";
import { defaultTextOptions } from "./theme.js";
import { entityDefinitions, entityKindSchema } from "@relay/contracts/entities";
import { entityAddress, type GraphNode } from "@relay/contracts/entities/graph";
import type {
  EntitiesPage,
  EntityDetail,
  EntitySaved,
  EntitySummary,
  EntityType,
} from "@relay/contracts/entities";
import type { TextOptions } from "./theme.js";
import { safeText } from "./text.js";
import { wrap } from "./layout.js";
import { renderMarkdown } from "./markdown.js";
import { columns } from "./board-tasks.js";
import { planningStatusLabels } from "./planning.js";

const labels = new Map(entityDefinitions.map((entry) => [entry.kind, entry.title]));
const readinessLabels: Record<string, string> = {
  none: "Не реализовано",
  partial: "Частично",
  done: "Готово",
};
/** Один код может иметь разный смысл у разных владельцев; неизвестный не интерпретируем. */
export function stateLabel(kind: string | undefined, value: string): string {
  let dictionary: Readonly<Record<string, string>> = {};
  if (kind === "task") dictionary = columns;
  else if (kind === "document") dictionary = documentStates;
  else if (kind === "work-plan" && ["draft", "active", "completed", "cancelled"].includes(value))
    dictionary = planningStatusLabels;
  else if (kind === "release" && ["planned", "released", "cancelled"].includes(value))
    dictionary = planningStatusLabels;
  else if (["feature", "scenario", "implementation"].includes(kind ?? "")) {
    if (kind === "implementation" && value === "inactive") return "Участие снято";
    dictionary = readinessLabels;
  }
  return Object.hasOwn(dictionary, value) ? dictionary[value]! : value;
}

function entityStateFields(entity: EntitySummary): OutputField[] {
  const kind = entity.ref.kind;
  if (kind === "implementation" && (entity.active === false || entity.status === "inactive"))
    return [["Состояние", "Участие снято"]];
  return [
    ...(kind === "implementation" ? [["Участие", "Активно"] as OutputField] : []),
    ...(entity.status
      ? [
          [
            ["feature", "scenario", "implementation"].includes(kind)
              ? "Готовность (расчёт)"
              : "Состояние",
            stateLabel(kind, entity.status),
          ] as OutputField,
        ]
      : []),
  ];
}
export function entityReadArgs(item: Pick<GraphNode, "ref" | "key">): string[] {
  if (!entityKindSchema.safeParse(item.ref.kind).success)
    return ["inspect", "resolve", entityAddress(item.ref)];
  if (item.ref.kind === "product" || item.ref.kind === "project") return [item.ref.kind, "get"];
  return [item.ref.kind === "work-plan" ? "plan" : item.ref.kind, "get", item.key];
}
export function filterFields(query: object): OutputField[] {
  const kind = "kind" in query && typeof query.kind === "string" ? query.kind : undefined;
  const names: Record<string, string> = {
    kind: "Вид",
    q: "Поиск",
    refs: "Ключи",
    application: "Приложение",
    feature: "Фича",
    scenario: "Сценарий",
    implementationTarget: "Вид цели реализации",
    target: "Цель",
    parent: "Родитель",
    board: "Доска",
    status: "Состояние",
    active: "Участие",
    section: "Раздел",
    documentKind: "Тип документа",
    pinned: "Закрепление",
    archived: "Архив",
    sort: "Сортировка",
    id: "Запись",
  };
  return Object.entries(query)
    .filter(([key, value]) => names[key] && value !== undefined)
    .map(([key, value]) => [
      names[key]!,
      key === "kind"
        ? (labels.get(value as EntitySummary["ref"]["kind"]) ?? String(value))
        : key === "status"
          ? stateLabel(kind, String(value))
          : Array.isArray(value)
            ? value.join(", ")
            : String(value),
    ]);
}
const documentStates = { draft: "Черновик", active: "Действующий", archived: "Архив" };
const documentKinds = {
  specification: "Техническое задание",
  description: "Описание",
  rules: "Правила",
  instruction: "Инструкция",
  proposal: "Проект решения",
  decision: "Решение",
  research: "Исследование",
};
type Page = { total: number; nextOffset: number | null; version: string };

/** Только обзор списка: ограничение помечено, полные поля get не проходят через этот helper. */
function entityAnnotation(value: string): string[] {
  const text = safeText(value).replace(/\s+/gu, " ").trim();
  if (!text) return [];
  const segments = new Intl.Segmenter("ru", { granularity: "grapheme" }).segment(text);
  let excerpt = "";
  let count = 0;
  for (const { segment } of segments) {
    if (count++ === 200) return [`Аннотация (фрагмент): ${excerpt}…`];
    excerpt += segment;
  }
  return [`Аннотация: ${text}`];
}

/** Основание прислал Core; совпадения не восстанавливаются догадкой из q или title. */
function entityMatchText(item: EntitySummary, q: string): string[] {
  const match = item.match;
  if (!match || match.field === "key" || match.field === "title") return [];
  if (match.field === "summary") {
    const annotation = entityAnnotation(item.summary)[0];
    const visible = annotation?.slice(annotation.indexOf(": ") + 2).toLowerCase();
    const needle = safeText(q).replace(/\s+/gu, " ").trim().toLowerCase();
    if (needle && visible?.includes(needle)) return [];
  }
  const fields: Record<typeof match.field, string> = {
    alias: "прежнем ключе",
    address: "постоянном адресе",
    id: "ID",
    summary: "аннотации",
    context: "контексте",
    description: "описании",
    body: "содержании",
    goal: "цели плана",
    version: "версии релиза",
    "application.key": "ключе приложения",
    "application.title": "названии приложения",
    "target.key": "ключе цели",
    "target.title": "названии цели",
  };
  // Сводка body нормализует Markdown и не заменяет полное чтение даже без усечения Core.
  const fragment = match.field === "body" || match.truncated;
  return [
    `Совпадение в ${fields[match.field]}${fragment ? " (фрагмент)" : ""}: ${safeText(match.text).replace(/\s+/gu, " ").trim()}`,
  ];
}

/** Компактный каталог одинаково раскрывает ключ, вид и контекст при любой ширине. */
export function entitiesText(
  page: EntitiesPage,
  query: object,
  options: TextOptions,
  _readCommands: string[] = [],
  _mode: "catalog" | "search" = "search",
): string {
  const kind = "kind" in query && typeof query.kind === "string" ? query.kind : undefined;
  const titles: Record<string, string> = {
    feature: "Фичи продукта",
    scenario: "Сценарии фич",
    application: "Приложения",
    implementation: "Реализации требований",
    document: "Документы",
  };
  const fixedParent = kind === "scenario" && "feature" in query && !!query.feature;
  const title = (kind && titles[kind]) || "Каталог сущностей";
  const items = page.items.map((item) => ({
    key: item.key,
    title: item.title,
    details: [
      ...(kind ? [] : [labels.get(item.ref.kind) ?? item.ref.kind]),
      ...(item.document
        ? [
            `${stateLabel("document", item.document.status)} · ${documentKinds[item.document.kind]} · Раздел: ${item.document.sectionId ?? "Без раздела"} · прикреплений ${item.document.linkCount}${item.document.pinned ? " · закреплён" : ""}`,
            ...("q" in query && query.q && item.document.excerpt && item.match?.field !== "body"
              ? [
                  `Совпадение в содержании (фрагмент): ${item.document.excerpt.replace(/\s+/gu, " ").trim()}`,
                ]
              : []),
          ]
        : entityStateFields(item).map(([label, value]) => `${label}: ${value}`)),
      ...entityAnnotation(item.summary ?? ""),
      ...("q" in query && typeof query.q === "string" && query.q
        ? entityMatchText(item, query.q)
        : []),
      ...(item.implementation
        ? [
            `Вид реализации: ${item.implementation.type}`,
            ...("application" in query && query.application
              ? []
              : [
                  `Приложение: ${item.implementation.application.key} · ${item.implementation.application.title}`,
                ]),
            `Цель: ${item.implementation.target.key} · ${item.implementation.target.title}`,
          ]
        : item.context && !fixedParent
          ? [item.context]
          : []),
      ...("sort" in query && query.sort === "updated"
        ? [`Изменён: ${item.updatedAt ?? item.document?.updatedAt ?? "дата не предоставлена"}`]
        : []),
    ],
  }));
  return listText(
    {
      title,
      filters: filterFields(query),
      items,
      emptyMessage:
        page.total === 0
          ? `Сущностей по этим условиям нет.${"q" in query && query.q ? " Комментарии, критерии и вложенные этапы в поиск не входят." : ""}`
          : "На этой странице сущностей нет.",
    },
    options,
  );
}

export function entityTypesText(
  page: Page & { items: EntityType[] },
  _query: object,
  options: TextOptions,
  _commands: string[] = [],
): string {
  return [
    listText(
      {
        title: "Виды сущностей",
        items: page.items.map((item) => ({
          key: item.kind,
          title: item.title,
          details: [item.description, `Действия: ${item.actions.join(", ")}`],
        })),
        emptyMessage: "На этой странице видов нет.",
      },
      options,
    ),
  ].join("\n\n");
}

/** Полное содержание имеет представление своего вида; Markdown сохраняет форматирование. */
export function entityText(
  entity: EntityDetail,
  options: TextOptions,
  commands: {
    scenarios?: string;
    overview?: string;
    context?: string;
    links?: string;
    deletion?: string;
    feature?: string;
    target?: string;
    application?: string;
    implementations?: string;
    participation?: string;
    progress?: string;
    tasks?: string;
    documents?: string;
    productContext?: string;
  } = {},
): string {
  const addresses = new Map(
    entity.references.map((item) => [
      `${item.ref.kind}:${item.ref.id}`,
      `${item.key} · ${item.title}`,
    ]),
  );
  const address = (kind: string, id: string | null) =>
    id
      ? safeText(addresses.get(`${kind}:${id}`) ?? `${kind}:${id} (название не предоставлено)`)
      : "—";
  const lines = [
    ...(entity.summary && entity.data.kind !== "document"
      ? [wrap(safeText(entity.summary), options.width)]
      : []),
  ];
  const data = entity.data;
  if (data.kind === "project") lines.push(`Адрес проекта: ${safeText(data.slug)}`);
  if (data.kind === "board")
    lines.push(
      `Область: ${data.scope}\nАдрес доски: ${data.slug}\nПрефикс: ${data.prefix ?? "—"}\nПриложение: ${address("application", data.applicationId)}`,
    );
  if (data.kind === "application")
    lines.push(
      `Тип: ${{ frontend: "Фронтенд", backend: "Бэкенд", internal: "Внутренний инструмент" }[data.type]}\nАдрес доски: ${safeText(data.slug)}\nПрефикс задач: ${safeText(data.prefix ?? "—")}`,
    );
  if (data.kind === "scenario") lines.push(`Фича: ${address("feature", data.featureId)}`);
  if (data.kind === "implementation")
    lines.push(
      `Приложение: ${address("application", data.applicationId)}\nФича: ${address("feature", data.featureId)}\nСценарий: ${data.scenarioId ? address("scenario", data.scenarioId) : "Общий вклад в фичу (FI)"}`,
      entity.savedStatus === undefined
        ? "Ручная совместимая отметка в этом ответе не раскрывается; вычисляемая готовность не заменяет сохранённый status."
        : `Совместимая отметка: ${entity.savedStatus} (не управляет вычисляемой готовностью)`,
    );
  if (data.kind === "document") {
    lines.push(
      `Тип документа: ${documentKinds[data.documentKind]}\nСостояние: ${safeText(stateLabel("document", data.documentStatus ?? "active"))}\nРаздел: ${safeText(entity.document?.sectionId ?? "Без раздела")}\nЗакреплён: ${data.pinned ? "да" : "нет"}`,
    );
    const relations = [
      ...data.links.map((link) => ({
        target: { kind: link.kind, id: link.kind === "product" ? "passport" : link.id },
        type: "legacy",
        description: "",
      })),
      ...(data.relations ?? []),
    ];
    const targets = new Set(relations.map(({ target }) => `${target.kind}:${target.id}`));
    lines.push(
      relations.length
        ? `Прикрепления: ${relations.length} · уникальных целей: ${targets.size}. Адреса и полные пояснения — document links.`
        : "Прикреплений нет.",
    );
  }
  if (data.kind === "task")
    lines.push(
      `Доска: ${address("board", data.boardId)}\nКолонка: ${safeText(stateLabel("task", data.column))}\nРодитель: ${address("task", data.parentId)}\nРеализует: ${data.productLinks.map((link) => address(link.kind, link.id)).join(", ") || "—"}\nЗависит от: ${data.dependencies.map((id) => address("task", id)).join(", ") || "—"}`,
    );
  const markdown = "description" in data ? data.description : "body" in data ? data.body : "";
  if (
    entity.references.length &&
    !["document", "task", "implementation", "scenario"].includes(data.kind)
  )
    lines.push(
      "Связанные записи:",
      ...entity.references.map((item) =>
        safeText(`${item.key} · ${labels.get(item.ref.kind)} · ${item.title}`),
      ),
    );
  return cardText(
    {
      title: `${entity.key} — ${entity.title}`,
      fields: [
        ["Вид", labels.get(entity.ref.kind)],
        ["Ревизия", entity.revision],
        ...(entity.metadata
          ? ([
              ["Изменён", entity.metadata.updatedAt],
              ["Изменил", entity.metadata.updatedBy],
            ] as OutputField[])
          : entity.document
            ? [["Изменён", entity.document.updatedAt] as OutputField]
            : []),
        ...(data.kind !== "document" ? entityStateFields(entity) : []),
      ],
      sections: [
        { title: "Сведения", body: lines.map((line) => wrap(line, options.width)).join("\n\n") },
        ...(data.kind === "document" && entity.summary
          ? [{ title: "Аннотация", body: safeText(entity.summary) }]
          : []),
        ...(markdown
          ? [{ title: "Полное содержание", body: renderMarkdown(markdown, options) }]
          : []),
      ],
      commands: Object.entries(commands)
        .filter((entry): entry is [string, string] => Boolean(entry[1]))
        .map(([label, command]) => ({
          label:
            {
              scenarios: "Сценарии",
              overview: "Карта продукта",
              feature: "Общие требования фичи",
              target: "Общее требование реализации",
              application: "Назначение приложения",
              implementations: "Реализации требований, включая снятые",
              participation: "Состав приложения и условия его изменения",
              progress: "Вычисляемая готовность и причины",
              tasks: "Связанные задачи",
              documents: "Прикреплённые документы",
              productContext: "Предметная подборка требований и вкладов (не граф связей)",
              context: "Связи графа: вся достижимая компонента (отдельное чтение)",
              links: "Прикрепления: адреса и полные пояснения страницами",
              deletion:
                data.kind === "document"
                  ? "Жизненный цикл: предпросмотр удаления документа (без изменений)"
                  : data.kind === "application"
                    ? "Жизненный цикл: предпросмотр удаления приложения с доской (без изменений)"
                    : "Жизненный цикл: полный предпросмотр удаления (без изменений)",
            }[label] ?? label,
          command,
        })),
    },
    options,
  );
}

export function entityResolvedText(
  entity: EntitySummary,
  options: TextOptions = defaultTextOptions,
  readCommand?: string,
): string {
  return cardText(
    {
      title: `${entity.key} — ${entity.title}`,
      fields: [
        ["Вид", labels.get(entity.ref.kind)],
        ["Ревизия", entity.revision],
        ["Постоянный технический адрес", `${entity.ref.kind}:${entity.ref.id}`],
      ],
      commands: readCommand ? [{ label: "Прочитать", command: readCommand }] : [],
    },
    options,
  );
}
export function entitySavedText(
  saved: EntitySaved,
  readCommand?: string,
  options: TextOptions = defaultTextOptions,
  actionTitle?: string,
): string {
  const actions = {
    create: "Запись создана",
    update: "Запись изменена",
    rename: "Ключ изменён",
    move: "Перемещена",
    link: "Связи изменены",
  };
  return receiptText(
    {
      title: `${actionTitle ?? actions[saved.action]}: ${saved.key}`,
      fields: [
        ["Вид", labels.get(saved.ref.kind)],
        [saved.ref.kind === "project" ? "Ревизия проекта" : "Ревизия", saved.revision],
      ],
      commands: readCommand ? [{ label: "Прочитать", command: readCommand }] : [],
    },
    options,
  );
}

export function entityTypeText(
  type: EntityType & {
    schema: Record<string, unknown>;
    createSchema: Record<string, unknown> | null;
    updateSchema: Record<string, unknown> | null;
  },
  options: TextOptions,
  ownerCommand?: string,
): string {
  const schema = type.createSchema ?? type.schema;
  const properties = schema.properties;
  const fields =
    properties && typeof properties === "object" && !Array.isArray(properties)
      ? Object.entries(properties)
      : [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  const rows = fields.map(([name, raw]) => {
    const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    return wrap(
      safeText(
        `${name}${required.includes(name) ? " (обязательно)" : ""} — ${typeof value.description === "string" ? value.description : name === "kind" ? "Вид сущности" : "Поле контракта"}${typeof value.type === "string" ? `; тип: ${value.type}` : ""}${Array.isArray(value.enum) ? `; значения: ${value.enum.join(", ")}` : ""}`,
      ),
      options.width,
    );
  });
  return cardText(
    {
      title: `${type.kind} — ${type.title}`,
      fields: [
        ["Контракт", type.contractVersion],
        ["Ключи", type.keyPolicy],
        ["Фильтры", ["q", "refs", ...type.filters].join(", ")],
        ["Действия", type.actions.join(", ")],
        ["Общее создание", type.createSchema ? "Поддержано" : "Не поддержано"],
        ["Общее изменение", type.updateSchema ? "Поддержано" : "Не поддержано"],
      ],
      sections: [
        { title: "Назначение", body: wrap(safeText(type.description), options.width) },
        {
          title: type.createSchema ? "Поля создания" : "Поля чтения",
          body: rows.join("\n") || "Схема не раскрывает отдельные поля.",
        },
        ...(
          [
            ["Схема чтения", type.schema],
            ["Схема создания", type.createSchema],
            ["Схема изменения", type.updateSchema],
          ] as const
        ).map(([title, schema]) => ({
          title,
          body: schema
            ? renderMarkdown(`\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``, options)
            : "Общая операция не поддержана; используйте предметные команды, перечисленные в действиях вида.",
        })),
      ],
      commands: ownerCommand
        ? [{ label: "Перейти к предметным записям", command: ownerCommand }]
        : [],
    },
    options,
  );
}
