import { listText, cardText } from "./common.js";
import { filterFields } from "./entities.js";
import type {
  ProductContext,
  ProductList,
  ProductListQuery,
  ProductMutation,
  ProductOverview,
  ProductState,
} from "@relay/core/domain/product";
import type { ContentWarning } from "@relay/core/application/product/content";
import type { ProductContentQuery } from "@relay/core/application/product/content";
import type { TextOptions } from "./theme.js";
import { wrap, section } from "./layout.js";
import { renderMarkdown } from "./markdown.js";
import { safeText, previewText } from "./text.js";
import type {
  ProductEntity,
  ProductEntitySummary,
  ProductEntitiesQuery,
} from "@relay/core/domain/product-implementation";

type RecordView = ProductEntity;
const kinds: Record<string, string> = {
  passport: "Паспорт",
  feature: "Фича",
  scenario: "Сценарий",
  application: "Приложение",
  document: "Документ",
  scope: "Состав реализации",
  contract: "Контракт",
  implementation: "Реализация",
};
const statuses = { none: "Не реализовано", partial: "Частично", done: "Готово" };
const nameOf = (record: RecordView) =>
  "name" in record.fields
    ? record.fields.name
    : "title" in record.fields
      ? record.fields.title
      : `Состав ${record.fields.applicationId}`;

/** Представление предметной записи: метаданные не смешиваются с Markdown-содержанием. */
export function productRecordText(record: RecordView, options: TextOptions): string {
  const fields = record.fields;
  const head = section(
    wrap(`${kinds[fields.kind]} · ${safeText(nameOf(record))}`, options.width),
    wrap(
      `${record.key ? `Ключ: ${record.key}\n` : ""}ID: ${record.id}\nРевизия: ${record.revision}\nАвтор: ${safeText(record.updatedBy)}`,
      options.width,
    ),
    options,
  );
  const parts = [head];
  if ("summary" in fields && fields.summary)
    parts.push(wrap(safeText(fields.summary), options.width));
  if (fields.kind === "scenario")
    parts.push(wrap(`Родительская фича: ${fields.featureId}`, options.width));
  if (fields.kind === "implementation")
    parts.push(
      wrap(
        `Приложение: ${fields.applicationId}\nФича: ${fields.featureId}\nСценарий: ${fields.scenarioId ?? "Общий вклад"}\n${fields.active ? statuses[fields.status] : "Участие снято"}`,
        options.width,
      ),
    );
  if (fields.kind === "application")
    parts.push(
      `Тип: ${{ frontend: "Фронтенд", backend: "Бэкенд", internal: "Внутренний инструмент" }[fields.type]}`,
      wrap(`Адрес приложения и доски: ${safeText(fields.slug)}`, options.width),
      wrap(`Префикс задач: ${safeText(fields.prefix ?? fields.slug.toUpperCase())}`, options.width),
    );
  if (fields.kind === "scope") {
    parts.push(wrap(`Приложение: ${fields.applicationId}`, options.width));
    if (!fields.contracts.length) parts.push("Контрактов пока нет.");
    for (const contract of fields.contracts)
      parts.push(
        section(
          safeText(contract.title),
          [
            wrap(
              `ID: ${contract.id}\nФича: ${contract.featureId}\nСценарий: ${contract.scenarioId ?? "общий вклад"}\n${contract.active ? statuses[contract.status] : "Участие снято"}`,
              options.width,
            ),
            renderMarkdown(contract.description, options),
          ].join("\n\n"),
          options,
        ),
      );
  } else {
    parts.push(
      renderMarkdown(fields.kind === "document" ? fields.body : fields.description, options),
    );
    if (fields.kind === "document") {
      parts.push(
        `Тип: ${safeText(fields.documentKind)}\nСостояние: ${safeText(fields.documentStatus ?? "active")}\nРаздел: ${safeText(fields.sectionId ?? "Без раздела")}\nЗакреплён: ${fields.pinned ? "да" : "нет"}`,
      );
      const links = fields.links.map((link) =>
        wrap(
          safeText(
            link.kind === "product"
              ? "Прежняя область: продукт"
              : `Прежняя область: ${link.kind}:${link.id}`,
          ),
          options.width,
        ),
      );
      const relations = (fields.relations ?? []).map(
        (link) =>
          `${safeText(link.type)}: ${safeText(`${link.target.kind}:${link.target.id}`)}${link.description ? `\n${renderMarkdown(link.description, options)}` : ""}`,
      );
      parts.push(section("Связи", [...links, ...relations].join("\n\n") || "Связей нет.", options));
    }
  }
  return parts.join("\n\n");
}

function listing(
  items: ProductOverview["items"],
  options: TextOptions,
  readiness: ProductOverview["readiness"] = [],
): string {
  const states = new Map(readiness.map((item) => [item.id, item.status]));
  return listText(
    {
      title: "Записи продукта",
      items: items.map((item) => ({
        key: item.key ?? item.id,
        title: item.name,
        details: [
          kinds[item.kind] ?? item.kind,
          ...(states.has(item.id)
            ? [`Готовность (расчёт): ${statuses[states.get(item.id)!]}`]
            : []),
          ...(item.kind === "scope"
            ? ["Техническая запись состава; приложение не раскрывается в этой сводке."]
            : []),
          ...(item.summary ? [previewText(item.summary, 120)] : []),
        ],
      })),
      emptyMessage: "На этой странице записей нет.",
    },
    options,
  );
}

export function productListText(
  data: ProductList,
  _query: ProductListQuery,
  options: TextOptions,
): string {
  const items = data.items.map((record) => ({
    id: record.id,
    ...(record.key ? { key: record.key } : {}),
    revision: record.revision,
    kind: record.fields.kind,
    name: nameOf(record),
    summary: "summary" in record.fields ? record.fields.summary : "",
  }));
  const parts = [
    section(`Записи продукта · ${items.length} из ${data.total}`, listing(items, options), options),
  ];
  return parts.join("\n\n");
}

export function productOverviewText(
  data: ProductOverview & {
    total?: number;
    readinessCounts?: { total: number; ready: number; stale: number };
  },
  options: TextOptions,
): string {
  const items = data.items;
  const ready =
    data.readinessCounts?.ready ?? data.readiness.filter((item) => item.status === "done").length;
  return [
    cardText(
      {
        title: "Карта продукта",
        fields: [
          ["Записей всего", data.total ?? data.items.length],
          [
            "Готовых фич и сценариев",
            `${ready} из ${data.readinessCounts?.total ?? data.readiness.length}`,
          ],
          [
            "Требуют переподтверждения",
            data.readinessCounts?.stale ?? data.readiness.filter((item) => item.stale > 0).length,
          ],
        ],
      },
      options,
    ),
    listing(items, options, data.readiness),
    wrap(`Версия для изменения состава: ${data.version}`, options.width),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Компактные цели для выбора связи; полное описание читается отдельной командой get. */
export function productEntitiesText(
  data: { items: ProductEntitySummary[]; total: number; nextOffset: number | null },
  _query: ProductEntitiesQuery,
  options: TextOptions,
): string {
  const items = data.items.map((entry) => ({
    id: entry.id,
    ...(entry.key ? { key: entry.key } : {}),
    revision: entry.revision,
    kind: entry.kind,
    name: entry.title,
    summary: [
      entry.applicationName,
      entry.targetKey,
      entry.targetName,
      entry.summary,
      entry.active ? "" : "Участие снято",
    ]
      .filter(Boolean)
      .join(" · "),
  }));
  return [
    section(
      `Продуктовые цели · ${items.length} из ${data.total}`,
      listing(items, options),
      options,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function productContextText(data: ProductContext, options: TextOptions): string {
  const sections = [
    section("Контекст продукта", `Включено записей: ${data.records.length}`, options),
  ];
  for (const { record, reasons } of data.records)
    sections.push(
      [
        productRecordText(record, options),
        section("Почему включено", wrap(safeText(reasons.join("; ")), options.width), options),
        ...data.readiness
          .filter((entry) => entry.id === record.id)
          .map((entry) =>
            wrap(
              `Готовность: ${statuses[entry.status]} · участников ${entry.participants} · готово ${entry.completed} · устарело ${entry.stale}`,
              options.width,
            ),
          ),
      ].join("\n\n"),
    );
  if (!data.records.length)
    sections.push(
      "Связанного контекста пока нет. Посмотрите npx @oim-dev/relay-cli product overview или выберите --id.",
    );
  return sections.join(`\n\n${"─".repeat(options.width)}\n\n`);
}

export function productStateText(data: ProductState, options: TextOptions): string {
  return section(
    "Снимок продукта",
    data.records.map((record) => productRecordText(record, options)).join("\n\n") ||
      "Продукт пока пуст.",
    options,
  );
}

export function productSavedText(
  command: ProductMutation,
  result: { id: string; key?: string | undefined; revision: number },
  options: TextOptions,
): string {
  const fields = command.fields;
  return section(
    command.action === "create" ? "Запись создана" : "Запись сохранена",
    wrap(
      [
        `${kinds[fields.kind]}${"name" in fields ? ` · ${safeText(fields.name)}` : ""}`,
        ...(result.key ? [`Ключ: ${result.key}`] : []),
        `ID: ${result.id}`,
        `Ревизия: ${result.revision}`,
        `Идентификатор запроса: ${safeText(command.requestId)}`,
      ].join("\n"),
      options.width,
    ),
    options,
  );
}

export function productLintText(
  data: { records: number; warnings: ContentWarning[]; total: number; nextOffset: number | null },
  options: TextOptions,
  _query: ProductContentQuery = {},
  keys: ReadonlyMap<string, string> = new Map(),
): string {
  return [
    listText(
      {
        title: "Качество содержания",
        filters: [["Проверено записей", data.records], ...filterFields(_query)],
        items: data.warnings.map((entry) => ({
          key: keys.get(entry.id) ?? entry.id,
          title: entry.name,
          details: [`${entry.field}: ${entry.message}`],
        })),
        emptyMessage:
          data.total === 0 ? "Структурных замечаний нет." : "На этой странице замечаний нет.",
      },
      options,
    ),
    "Это структурная подсказка, а не подтверждение полноты требований.",
  ].join("\n\n");
}
