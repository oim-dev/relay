import type {
  DocumentBulkResult,
  DocumentFacets,
  EntityDocumentsPage,
} from "@relay/contracts/entities/document-catalog";
import { cardText, listText } from "./common.js";
import type { OutputCommand, OutputField } from "./common.js";
import {
  documentFormats,
  documentSummaryDetails,
  filterFields,
  sectionLabel,
  stateLabel,
} from "./entities.js";
import type { SectionNames } from "./entities.js";
import { wrap } from "./layout.js";
import { renderMarkdown } from "./markdown.js";
import { safeText } from "./safe.js";
import type { TextOptions } from "./theme.js";

const relationTitles = {
  references: "Для чтения (references)",
  documents: "Описывает сущность (documents)",
};
const documentKindLabels: Record<string, string> = {
  specification: "Техническое задание",
  description: "Описание",
  rules: "Правила",
  instruction: "Инструкция",
  proposal: "Проект решения",
  decision: "Решение",
  research: "Исследование",
};
const viewLabels: Record<keyof DocumentFacets["views"], string> = {
  all: "Все (без архива)",
  pinned: "Закреплённые",
  draft: "Черновики",
  unsectioned: "Без раздела",
  unattached: "Без прикреплений",
  archived: "Архив",
};
const bulkStatusLabels: Record<DocumentBulkResult["items"][number]["status"], string> = {
  applied: "Сохранено",
  unchanged: "Без изменений",
  conflict: "Конфликт ревизии",
  not_found: "Не найден",
  invalid: "Нарушено правило данных",
  error: "Отказ",
};

function counts(rows: readonly (readonly [string, number])[], empty: string): string {
  return rows.length ? rows.map(([label, count]) => `${label}: ${count}`).join("\n") : empty;
}

/** Счётчики каталога: полные данные проекта, каждая ось — без собственного фильтра. */
export function documentFacetsText(
  facets: DocumentFacets,
  query: object,
  options: TextOptions,
  commands: readonly OutputCommand[] = [],
  sectionNames?: SectionNames,
): string {
  const sections = (lines: string) => wrap(safeText(lines), options.width);
  return cardText(
    {
      title: "Счётчики библиотеки документов",
      fields: [
        ...filterFields(query),
        ["Подходит под все фильтры", facets.total],
        ["Версия каталога", facets.version],
      ],
      sections: [
        {
          title: "Представления (без фильтров раздела, состояния, архива и закрепления)",
          body: sections(
            counts(
              (Object.keys(viewLabels) as (keyof DocumentFacets["views"])[]).map((key) => [
                viewLabels[key],
                facets.views[key],
              ]),
              "—",
            ),
          ),
        },
        {
          title: "Разделы",
          body: sections(
            counts(
              facets.sections.map((row) => [sectionLabel(row.sectionId, sectionNames), row.count]),
              "Разделов нет.",
            ),
          ),
        },
        {
          title: "Теги (размер выборки после добавления тега)",
          body: sections(
            counts(
              facets.tags.map((row) => [row.tag, row.count]),
              "Тегов в выборке нет.",
            ),
          ),
        },
        {
          title: "Форматы",
          body: sections(
            counts(
              facets.formats.map((row) => [documentFormats[row.format], row.count]),
              "—",
            ),
          ),
        },
        {
          title: "Типы",
          body: sections(
            counts(
              facets.kinds.map((row) => [documentKindLabels[row.kind] ?? row.kind, row.count]),
              "—",
            ),
          ),
        },
        {
          title: "Состояния",
          body: sections(
            counts(
              facets.statuses.map((row) => [stateLabel("document", row.status), row.count]),
              "—",
            ),
          ),
        },
      ],
      commands,
    },
    options,
  );
}

/** Поэлементный результат: частичный отказ виден до чтения кода выхода. */
export function documentBulkText(
  result: DocumentBulkResult,
  operation: string,
  options: TextOptions,
  readCommands: Readonly<Record<string, string>>,
): string {
  const unchanged = result.items.filter((item) => item.status === "unchanged").length;
  const summary: OutputField[] = [
    ["Действие", operation],
    ["Сохранено", result.applied],
    ["Без изменений", unchanged],
    ["Отказов", result.failed],
    ["requestId", result.requestId],
  ];
  const list = listText(
    {
      title:
        result.failed === 0
          ? "Массовое изменение документов выполнено"
          : result.applied + unchanged === 0
            ? "Массовое изменение документов не выполнено ни для одного документа"
            : "Массовое изменение документов выполнено частично",
      filters: summary,
      items: result.items.map((item) => ({
        key: item.key ?? item.ref,
        title: bulkStatusLabels[item.status],
        details: [
          ...(item.key && item.key !== item.ref ? [`Запрошен как: ${item.ref}`] : []),
          ...(item.revision === undefined
            ? []
            : [
                item.status === "conflict"
                  ? `Актуальная ревизия: ${item.revision}`
                  : `Ревизия: ${item.revision}`,
              ]),
          ...(item.error ? [`${item.error.code}: ${item.error.message}`] : []),
        ],
      })),
      emptyMessage: "Элементов нет.",
    },
    options,
  );
  const failed = result.items.filter(
    (item) => item.status !== "applied" && item.status !== "unchanged",
  );
  if (!failed.length) return list;
  return [
    list,
    wrap(
      "Сохранённые элементы не откатываются, повторов не было. Перечитайте документы с отказом и решите, нужно ли новое действие только для них; при конфликте сначала сверьте актуальное содержание, а не подставляйте новую ревизию.",
      options.width,
    ),
    ...failed
      .map((item) => readCommands[item.ref])
      .filter((command): command is string => Boolean(command))
      .map((command) => `Перечитать:\n${safeText(command)}`),
  ].join("\n\n");
}

/** Обратное чтение: прямые прикрепления сущности, описания связей полностью. */
export function entityDocumentsText(
  page: EntityDocumentsPage,
  options: TextOptions,
  readCommands: readonly string[],
  sectionNames?: SectionNames,
): string {
  return cardText(
    {
      title: `Материалы ${page.target.key} — ${page.target.title}`,
      fields: [
        ["Всего материалов", page.total],
        ["Учитываются", "только прямые прикрепления, без родителей и детей"],
      ],
      sections: page.items.length
        ? page.items.map((item, index) => ({
            title: `${item.document.key} — ${item.document.title}${item.archived ? " (архив)" : ""}`,
            body: [
              (item.document.document
                ? documentSummaryDetails(item.document.document, sectionNames)
                : []
              )
                .map((line) => wrap(safeText(line), options.width))
                .join("\n"),
              ...item.relations.map((relation) =>
                [
                  wrap(
                    relation.source === "links"
                      ? "Совместимая продуктовая область (links)"
                      : relationTitles[relation.type],
                    options.width,
                  ),
                  ...(relation.description ? [renderMarkdown(relation.description, options)] : []),
                ].join("\n"),
              ),
              ...(readCommands[index] ? [`Прочитать:\n${safeText(readCommands[index])}`] : []),
            ].join("\n\n"),
          }))
        : [
            {
              title: "Материалы",
              body:
                page.total === 0
                  ? "К этой сущности напрямую не прикреплено ни одного материала."
                  : "На этой странице материалов нет.",
            },
          ],
    },
    options,
  );
}
