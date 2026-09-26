import Table from "cli-table3";
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
import { palette } from "./theme.js";
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
    if (fields.kind === "document")
      parts.push(
        section(
          "Связи",
          fields.links.length
            ? fields.links
                .map((link) =>
                  wrap(
                    link.kind === "product"
                      ? "• Продукт"
                      : `• ${link.kind === "implementation" ? "Реализация" : kinds[link.kind]}: ${link.id}${link.kind === "implementation" ? ` · ${link.applicationId}` : ""}`,
                    options.width,
                  ),
                )
                .join("\n")
            : "Связей нет.",
          options,
        ),
      );
  }
  return parts.join("\n\n");
}

function listing(items: ProductOverview["items"], options: TextOptions): string {
  if (!items.length) return "Записей пока нет.";
  if (options.width < 80)
    return items
      .map((item) =>
        wrap(
          [
            `${kinds[item.kind] ?? item.kind} · ${safeText(item.name)}`,
            `${item.key ? `Ключ: ${item.key}\n` : ""}ID: ${item.id} · ревизия ${item.revision}`,
            safeText(previewText(item.summary, 120)),
          ]
            .filter(Boolean)
            .join("\n"),
          options.width,
        ),
      )
      .join("\n\n");
  const table = new Table({
    head: ["Тип", "Название и описание", "ID / ревизия"],
    colWidths: [15, options.width - 61, 42],
    wordWrap: true,
    wrapOnWordBoundary: false,
    style: { head: [], border: [], "padding-left": 1, "padding-right": 1 },
  });
  for (const item of items)
    table.push([
      kinds[item.kind] ?? item.kind,
      safeText(item.name) + (item.summary ? `\n${safeText(previewText(item.summary, 120))}` : ""),
      `${item.key ? `${item.key}\n` : ""}${item.id}\nревизия ${item.revision}`,
    ]);
  return table.toString();
}

export function productListText(
  data: ProductList,
  query: ProductListQuery,
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
  if (data.nextOffset !== null) {
    const quote = (value: string) => `'${safeText(value).replaceAll("'", "'\\''")}'`;
    parts.push(
      wrap(
        `Продолжение (с тем же --config/--project): product list --offset ${data.nextOffset} --limit ${query.limit ?? 30}${query.kind ? ` --kind ${query.kind}` : ""}${query.q ? ` --q ${quote(query.q)}` : ""}${query.id ? ` --id ${query.id}` : ""}`,
        options.width,
      ),
    );
  }
  return parts.join("\n\n");
}

export function productOverviewText(data: ProductOverview, options: TextOptions): string {
  const items = data.items.slice(0, 30);
  const ready = data.readiness.filter((item) => item.status === "done").length;
  return [
    section(
      "Продукт",
      wrap(
        `Записей: ${data.items.length}\nГотовых фич и сценариев: ${ready} из ${data.readiness.length}\nТребуют переподтверждения: ${data.readiness.filter((item) => item.stale > 0).length}`,
        options.width,
      ),
      options,
    ),
    listing(items, options),
    data.items.length > items.length
      ? `Показано ${items.length} из ${data.items.length}. Все записи: product list --limit 30`
      : "",
    wrap(`Версия для изменения состава: ${data.version}`, options.width),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Компактные цели для выбора связи; полное описание читается отдельной командой get. */
export function productEntitiesText(
  data: { items: ProductEntitySummary[]; total: number; nextOffset: number | null },
  query: ProductEntitiesQuery,
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
  const quote = (value: string) => `'${safeText(value).replaceAll("'", "'\\''")}'`;
  return [
    section(
      `Продуктовые цели · ${items.length} из ${data.total}`,
      listing(items, options),
      options,
    ),
    data.nextOffset === null
      ? ""
      : wrap(
          `Продолжение (с тем же --config/--project): product entities --offset ${data.nextOffset} --limit ${query.limit ?? 30}${query.q ? ` --q ${quote(query.q)}` : ""}${query.kind ? ` --kind ${query.kind}` : ""}${query.application ? ` --application ${quote(query.application)}` : ""}${query.active ? ` --active ${query.active}` : ""}`,
          options.width,
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
    sections.push("Связанного контекста пока нет. Посмотрите product overview или выберите --id.");
  return sections.join(`\n\n${palette(options).dim("─".repeat(options.width))}\n\n`);
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
  query: ProductContentQuery = {},
): string {
  return section(
    "Качество содержания",
    [
      `Записей: ${data.records}. Показано предупреждений: ${data.warnings.length} из ${data.total}.`,
      ...data.warnings.map((entry) =>
        wrap(
          `• ${safeText(entry.name)} (${entry.id})\n  ${entry.field}: ${entry.message}`,
          options.width,
        ),
      ),
      "Это структурная подсказка, а не подтверждение полноты требований.",
      ...(data.nextOffset === null
        ? []
        : [
            wrap(
              `Продолжение (с тем же --config/--project): product lint --offset ${data.nextOffset} --limit ${query.limit ?? 30}${query.id ? ` --id ${query.id}` : ""}`,
              options.width,
            ),
          ]),
    ].join("\n\n"),
    options,
  );
}
