import Table from "cli-table3";
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

const labels = new Map(entityDefinitions.map((entry) => [entry.kind, entry.title]));
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
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
type Page = { total: number; nextOffset: number | null; version: string };

/** Продолжение сохраняет фильтры, размер страницы и версию снимка. */
export function entityContinuation(page: Page, command: string, query: object): string {
  if (page.nextOffset === null) return `Всего: ${page.total}. Выборка прочитана полностью.`;
  const args = Object.entries({ ...query, offset: page.nextOffset, version: page.version })
    .filter(([, value]) => value !== undefined)
    .map(
      ([key, value]) =>
        `--${key === "version" ? "snapshot-version" : key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} ${(Array.isArray(value) ? value : [value]).map((part) => quote(String(part))).join(" ")}`,
    );
  return `Всего: ${page.total}.\nПродолжение: relay-cli entities ${command} ${args.join(" ")}`;
}

/** Ключ является основным обозначением; узкий терминал получает карточки вместо широкой таблицы. */
export function entitiesText(page: EntitiesPage, query: object, options: TextOptions): string {
  const table = new Table({
    head: ["Ключ", "Вид", "Название", "Состояние"],
    wordWrap: true,
    colWidths: [22, 16, Math.max(20, options.width - 57), 14],
  });
  const rows = page.items.map((item) => [
    item.key,
    labels.get(item.ref.kind) ?? item.ref.kind,
    item.title,
    item.document ? documentStates[item.document.status] : (item.status ?? "—"),
  ]);
  table.push(...rows.map((row) => row.map(safeText)));
  const content =
    page.items.length === 0
      ? "Сущностей по этим условиям нет."
      : options.width < 100
        ? page.items
            .map((item) =>
              wrap(
                safeText(
                  `${item.key} · ${labels.get(item.ref.kind)} · ${item.title}${item.status ? ` · ${item.status}` : ""}${item.summary ? `\n${item.summary}` : ""}`,
                ),
                options.width,
              ),
            )
            .join("\n\n")
        : table.toString();
  return ["Сущности проекта", content, entityContinuation(page, "list", query)].join("\n\n");
}

export function entityTypesText(
  page: Page & { items: EntityType[] },
  query: object,
  options: TextOptions,
): string {
  return [
    "Виды сущностей",
    ...page.items.map((item) =>
      wrap(
        `${item.kind} — ${item.title}\n${item.description}\nДействия: ${item.actions.join(", ")}`,
        options.width,
      ),
    ),
    entityContinuation(page, "types", query),
  ].join("\n\n");
}

/** Полное содержание имеет представление своего вида; Markdown сохраняет форматирование. */
export function entityText(entity: EntityDetail, options: TextOptions): string {
  const addresses = new Map(
    entity.references.map((item) => [
      `${item.ref.kind}:${item.ref.id}`,
      `${item.key} · ${item.title}`,
    ]),
  );
  const address = (kind: string, id: string | null) =>
    id ? safeText(addresses.get(`${kind}:${id}`) ?? `${kind}:${id}`) : "—";
  const lines = [
    `${safeText(entity.key)} — ${safeText(entity.title)}`,
    `${labels.get(entity.ref.kind)} · ревизия ${entity.revision}${entity.status ? ` · ${safeText(entity.status)}` : ""}`,
    ...(entity.summary ? [wrap(safeText(entity.summary), options.width)] : []),
  ];
  const data = entity.data;
  if (data.kind === "project") lines.push(`Адрес проекта: ${safeText(data.slug)}`);
  if (data.kind === "board")
    lines.push(
      `Область: ${data.scope}\nАдрес доски: ${data.slug}\nПрефикс: ${data.prefix ?? "—"}\nПриложение: ${address("application", data.applicationId)}`,
    );
  if (data.kind === "application")
    lines.push(
      `Тип: ${data.type}\nАдрес доски: ${data.slug}\nПрефикс задач: ${data.prefix ?? "—"}`,
    );
  if (data.kind === "scenario") lines.push(`Фича: ${address("feature", data.featureId)}`);
  if (data.kind === "implementation")
    lines.push(
      `Приложение: ${address("application", data.applicationId)}\nФича: ${address("feature", data.featureId)}\nСценарий: ${address("scenario", data.scenarioId)}\nУчастие: ${data.active ? "активно" : "снято"}`,
    );
  if (data.kind === "document") {
    lines.push(
      `Тип документа: ${documentKinds[data.documentKind]}\nСостояние: ${documentStates[data.documentStatus ?? "active"]}\nРаздел: ${safeText(entity.document?.sectionId ?? "Без раздела")}\nЗакреплён: ${data.pinned ? "да" : "нет"}`,
    );
    const relations = [
      ...data.links.map((link) => ({
        target: { kind: link.kind, id: link.kind === "product" ? "passport" : link.id },
        type: "documents",
        description: "",
      })),
      ...(data.relations ?? []),
    ];
    lines.push(
      "Связи:",
      ...relations.map(
        (link) =>
          `${link.type === "documents" ? "Описывает" : "Контекст"}: ${address(link.target.kind, link.target.id)}${link.description ? `\n${renderMarkdown(link.description, options)}` : ""}`,
      ),
    );
    if (relations.length === 0) lines.push("Пока без связей.");
  }
  if (data.kind === "task")
    lines.push(
      `Доска: ${address("board", data.boardId)}\nКолонка: ${data.column}\nРодитель: ${address("task", data.parentId)}\nРеализует: ${data.productLinks.map((link) => address(link.kind, link.id)).join(", ") || "—"}\nЗависит от: ${data.dependencies.map((id) => address("task", id)).join(", ") || "—"}\nСвязана с: ${data.related.map((id) => address("task", id)).join(", ") || "—"}`,
    );
  const markdown = "description" in data ? data.description : "body" in data ? data.body : "";
  if (markdown) lines.push(renderMarkdown(markdown, options));
  lines.push(
    `Контекст: relay-cli graph context ${quote(entity.key)}\nID: ${safeText(entity.ref.id)}`,
  );
  return lines.join("\n\n");
}

export function entityResolvedText(entity: EntitySummary): string {
  return `${safeText(entity.key)} — ${safeText(entity.title)}\nВид: ${labels.get(entity.ref.kind)}\nID: ${safeText(entity.ref.id)}\nРевизия: ${entity.revision}`;
}
export function entitySavedText(saved: EntitySaved): string {
  const actions = {
    create: "Создана",
    update: "Изменена",
    rename: "Ключ изменён",
    move: "Перемещена",
    link: "Связи изменены",
  };
  return `${actions[saved.action]}: ${safeText(saved.key)}\nВид: ${labels.get(saved.ref.kind)}\nID: ${saved.ref.id}\nРевизия: ${saved.revision}\nИдентификатор запроса: ${safeText(saved.requestId)}`;
}

export function entityTypeText(
  type: EntityType & {
    schema: Record<string, unknown>;
    createSchema: Record<string, unknown> | null;
    updateSchema: Record<string, unknown> | null;
  },
  options: TextOptions,
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
      `${name}${required.includes(name) ? " (обязательно)" : ""} — ${typeof value.description === "string" ? value.description : name === "kind" ? "Вид сущности" : "Поле контракта"}`,
      options.width,
    );
  });
  return [
    `${type.kind} — ${type.title}`,
    type.description,
    `Контракт: ${type.contractVersion}\nКлючи: ${type.keyPolicy}`,
    `Фильтры: ${["q", "refs", ...type.filters].join(", ")}\nДействия: ${type.actions.join(", ")}`,
    "Поля",
    ...rows,
  ].join("\n\n");
}
