import { cardText, listText, receiptText, commandText } from "./common.js";
import type { OutputField } from "./common.js";
import { defaultTextOptions } from "./theme.js";
import { entityDefinitions } from "@relay/contracts/entities";
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
export function entityReadArgs(item: EntitySummary): string[] {
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

/** Компактный каталог одинаково раскрывает ключ, вид и контекст при любой ширине. */
export function entitiesText(
  page: EntitiesPage,
  query: object,
  options: TextOptions,
  readCommands: string[] = [],
): string {
  return [
    listText(
      {
        title: "Каталог сущностей",
        filters: filterFields(query),
        items: page.items.map((item) => ({
          key: item.key,
          title: item.title,
          details: [
            labels.get(item.ref.kind) ?? item.ref.kind,
            ...(item.document
              ? [
                  stateLabel("document", item.document.status),
                  documentKinds[item.document.kind],
                  `Раздел: ${item.document.sectionId ?? "Без раздела"} · связей ${item.document.linkCount}${item.document.pinned ? " · закреплён" : ""}`,
                ]
              : entityStateFields(item).map(([label, value]) => `${label}: ${value}`)),
            ...(item.context ? [item.context] : []),
          ],
        })),
        emptyMessage:
          page.total === 0 ? "Сущностей по этим условиям нет." : "На этой странице сущностей нет.",
      },
      options,
    ),
    ...readCommands.map(
      (command, index) =>
        `Прочитать ${safeText(page.items[index]!.key)}:\n${commandText(command, options)}`,
    ),
  ].join("\n\n");
}

export function entityTypesText(
  page: Page & { items: EntityType[] },
  _query: object,
  options: TextOptions,
  commands: string[] = [],
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
    ...commands.map(
      (command, index) =>
        `Изучить ${safeText(page.items[index]!.kind)}:\n${commandText(command, options)}`,
    ),
  ].join("\n\n");
}

/** Полное содержание имеет представление своего вида; Markdown сохраняет форматирование. */
export function entityText(
  entity: EntityDetail,
  options: TextOptions,
  commands: { scenarios?: string; overview?: string; context?: string } = {},
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
  const relationSections: { title: string; body: string }[] = [];
  const lines = [...(entity.summary ? [wrap(safeText(entity.summary), options.width)] : [])];
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
      "Ручная совместимая отметка в этом ответе не раскрывается; вычисляемая готовность не заменяет сохранённый status.",
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
    for (const link of relations)
      relationSections.push({
        title:
          link.type === "legacy"
            ? "Прежняя продуктовая область (links)"
            : link.type === "documents"
              ? "Документ описывает (documents)"
              : "Цель ссылается на документ (references)",
        body: [
          wrap(address(link.target.kind, link.target.id), options.width),
          ...(link.description ? [renderMarkdown(link.description, options)] : []),
        ].join("\n\n"),
      });
    if (relations.length === 0)
      relationSections.push({ title: "Прикрепления", body: "Пока без связей." });
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
        ...(data.kind !== "document" ? entityStateFields(entity) : []),
      ],
      sections: [
        { title: "Сведения", body: lines.map((line) => wrap(line, options.width)).join("\n\n") },
        ...(markdown
          ? [{ title: "Полное содержание", body: renderMarkdown(markdown, options) }]
          : []),
        ...relationSections,
      ],
      commands: Object.entries(commands)
        .filter((entry): entry is [string, string] => Boolean(entry[1]))
        .map(([label, command]) => ({
          label:
            { scenarios: "Сценарии", overview: "Карта продукта", context: "Контекст" }[label] ??
            label,
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
