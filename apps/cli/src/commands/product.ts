import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { entityCreateSchema, entityUpdateSchema } from "@relay/contracts/entities";
import type { EntitiesQuery, EntityDetail } from "@relay/contracts/entities";
import { parse } from "@relay/core/domain/validation";
import { invariant } from "@relay/core/shared/errors";
import { lintProduct } from "@relay/core/application/product/content";
import { commandGroup, registerCommand } from "../command.js";
import { author } from "../context.js";
import type { CommandContext, Runtime } from "../context.js";
import { integer } from "../options.js";
import {
  textOption,
  readTextFields,
  paging,
  offsetQuery,
  pageResult,
  commandInvocation,
} from "../command-kit.js";
import { entitiesText, entityText, entitySavedText } from "../presentation/entities.js";
import { productOverviewText, productLintText } from "../presentation/product.js";
import { cardText } from "../presentation/common.js";
import { registerEntityProgress } from "./progress.js";
import { registerDocumentRelations, registerDocumentSections } from "./product-documents.js";
import { registerParticipation } from "./product-participation.js";

type Kind = "product" | "feature" | "scenario" | "application" | "implementation" | "document";
type Options = Record<string, unknown> & {
  ifRevision?: number;
  requestId?: string;
  limit?: number;
  cursor?: string;
};
const titles: Record<Kind, string> = {
  product: "Паспорт продукта",
  feature: "Фичи продукта",
  scenario: "Сценарии фич",
  application: "Приложения",
  implementation: "Реализации требований",
  document: "Библиотека документов",
};
const examples: Record<Kind, string> = {
  product: "",
  feature: "FEATURE-1",
  scenario: "SCENARIO-1",
  application: "WEB",
  implementation: "WEB-FI-1",
  document: "DOC-1",
};
function writeExample(kind: Kind, action: "create" | "update") {
  const base = `npx @oim-dev/relay-cli ${kind} ${action}`;
  const name = kind === "implementation" ? "--title" : "--name";
  if (action === "update")
    return `${base}${examples[kind] ? ` ${examples[kind]}` : ""} --actor agent ${name} 'Уточнённое название' --if-revision 1`;
  const extra =
    kind === "scenario"
      ? " --feature FEATURE-1"
      : kind === "application"
        ? " --slug web"
        : kind === "implementation"
          ? " --application WEB --target FEATURE-1"
          : "";
  return `${base} --actor agent ${name} 'Новая запись' --${kind === "document" ? "body" : "description"} '## Назначение\n\nПолное описание требований и результата.'${extra}`;
}
const texts = (kind: Kind) =>
  kind === "document"
    ? ["summary", "body"]
    : kind === "scenario" || kind === "implementation"
      ? ["description"]
      : ["summary", "description"];
export const revisionOption = (command: Command) =>
  command
    .requiredOption(
      "--if-revision <n>",
      "Прочитанная ревизия; при конфликте перечитайте запись",
      integer(0, Number.MAX_SAFE_INTEGER),
    )
    .option("--request-id <id>", "Корреляция, не гарантия безопасного повтора");

export async function subject(
  context: CommandContext,
  kind: Kind,
  ref: string,
): Promise<EntityDetail> {
  return context.backend.entities.get({ kind, ref });
}

function fieldOptions(command: Command, kind: Kind, creating: boolean) {
  const title = kind === "implementation" ? "title" : "name";
  if (creating) command.requiredOption(`--${title} <text>`, "Однострочное название");
  else command.option(`--${title} <text>`, "Новое однострочное название");
  for (const field of texts(kind))
    textOption(
      command,
      field,
      field === "summary" ? "Краткое обычное описание" : "Полное содержание Markdown",
    );
  if (!creating && texts(kind).includes("summary"))
    command.option("--clear-summary", "Очистить краткое описание");
  if (kind === "scenario" && creating)
    command.requiredOption("--feature <ref>", "Родительская фича: ключ или ID");
  if (kind === "application") {
    command.option("--type <type>", "Тип: frontend/backend/internal");
    if (creating)
      command
        .requiredOption("--slug <slug>", "Неизменяемый адрес приложения")
        .option("--prefix <prefix>", "Неизменяемый префикс задач");
  }
  if (kind === "implementation") {
    if (creating)
      command
        .requiredOption("--application <ref>", "Приложение")
        .requiredOption("--target <ref>", "Фича или сценарий");
    command.option(
      "--status <status>",
      "Совместимая отметка none/partial/done; не меняет вычисляемую готовность",
    );
  }
  if (kind === "document") {
    command
      .option(
        "--document-kind <kind>",
        "Назначение: specification/description/rules/instruction/proposal/decision/research",
      )
      .option("--document-status <state>", "Состояние: draft/active/archived")
      .option("--section-id <id>", "Раздел библиотеки")
      .option("--clear-section", "Оставить без раздела")
      .option("--pinned <value>", "Закрепление: true/false", (value) => {
        invariant(
          value === "true" || value === "false",
          "INVALID_ARGUMENT",
          "Укажите --pinned true или false",
        );
        return value === "true";
      })
      .option(
        "--targets <refs...>",
        "Заменить прежние продуктовые области; адресные связи — document link",
      )
      .option("--clear-targets", "Очистить прежние продуктовые области")
      .option("--clear-relations", "Очистить адресные отношения; прежние области сохраняются");
  }
  return creating
    ? command.option("--request-id <id>", "Корреляция, не безопасный повтор")
    : revisionOption(command);
}

async function readFields(
  context: CommandContext,
  options: Options,
  kind: Kind,
  creating: boolean,
) {
  const text = await readTextFields(context, options, texts(kind));
  invariant(
    !(options.clearSummary && text.summary !== undefined),
    "INVALID_ARGUMENT",
    "--clear-summary несовместим с источником --summary",
  );
  invariant(
    !(options.clearSection && options.sectionId !== undefined),
    "INVALID_ARGUMENT",
    "Выберите --section-id или --clear-section",
  );
  invariant(
    !(options.clearTargets && options.targets !== undefined),
    "INVALID_ARGUMENT",
    "Выберите --targets или --clear-targets",
  );
  const fields: Record<string, unknown> = { kind, ...text };
  for (const name of [
    "name",
    "title",
    "type",
    "slug",
    "prefix",
    "application",
    "target",
    "status",
    "documentKind",
    "documentStatus",
    "sectionId",
    "pinned",
    "targets",
  ])
    if (options[name] !== undefined) fields[name] = options[name];
  if (options.feature !== undefined) fields.featureId = options.feature;
  if (options.clearSummary) fields.summary = "";
  if (options.clearSection) fields.sectionId = null;
  if (options.clearTargets) fields.targets = [];
  if (options.clearRelations) fields.relations = [];
  if (creating) {
    if (texts(kind).includes("summary") && fields.summary === undefined) fields.summary = "";
    if (kind === "application" && fields.type === undefined) fields.type = "frontend";
    if (kind === "document" && fields.documentKind === undefined)
      fields.documentKind = "description";
  } else
    invariant(
      Object.keys(fields).length > 1,
      "INVALID_ARGUMENT",
      "Укажите хотя бы одно изменяемое поле; справка: <вид> update --help",
    );
  return fields;
}

/** Единственный предметный путь: паспорт — singleton, остальные виды — адресные группы. */
export function registerProduct(program: Command, runtime: Runtime): void {
  for (const kind of [
    "product",
    "feature",
    "scenario",
    "application",
    "implementation",
    "document",
  ] as const) {
    const singleton = kind === "product";
    const group = commandGroup(program, {
      name: kind,
      description: titles[kind],
      details:
        "Обычный ввод без JSON. Изменение передаёт только указанные поля и требует прочитанной ревизии.",
      examples: [
        [`npx @oim-dev/relay-cli ${kind} ${singleton ? "get" : "list"}`, "Прочитать данные"],
      ],
    });
    if (!singleton)
      registerCommand<Omit<EntitiesQuery, "limit"> & { limit?: number; cursor?: string }>(
        group,
        runtime,
        {
          name: "list",
          description: "Найти записи",
          details: "Согласованный снимок; продолжение сохраняет фильтры. Полное содержание — get.",
          examples: [[`npx @oim-dev/relay-cli ${kind} list --limit 20`, "Прочитать страницу"]],
          configure(command) {
            paging(command)
              .option("--q <text>", "Поиск")
              .option("--sort <field>", "Сортировка: key/title/updated");
            if (
              kind === "feature" ||
              kind === "scenario" ||
              kind === "implementation" ||
              kind === "document"
            )
              command.option("--status <state>", "Предметное состояние");
            if (kind === "scenario" || kind === "implementation")
              command.option("--feature <ref>", "Родительская фича");
            if (kind === "implementation")
              command
                .option("--application <ref>", "Приложение")
                .option("--scenario <ref>", "Сценарий")
                .option("--target <ref>", "Цель реализации")
                .option("--active <value>", "Участие: true/false");
            if (kind === "document")
              command
                .option("--target <ref>", "Прикрепление к сущности")
                .option("--section <id>", "Раздел; none — без раздела")
                .option("--document-kind <kind>", "Тип документа")
                .option("--pinned <value>", "Закрепление: true/false")
                .option("--archived <value>", "Архив: true/false");
          },
          async run(context, input) {
            const { cursor: _cursor, limit: _limit, ...filters } = input.options;
            const command = [kind, "list"];
            const query = offsetQuery(context, input.options, command, filters);
            const data = await context.backend.entities.list({ ...filters, kind, ...query });
            return {
              data,
              page: pageResult(context, command, filters, query, data),
              text: (options) => entitiesText(data, { ...filters, kind }, options),
            };
          },
        },
      );
    registerCommand(group, runtime, {
      name: singleton ? "get" : "get <ref>",
      ...(singleton ? {} : { arguments: { ref: "Ключ или ID записи" } }),
      description: "Прочитать полное содержание и ревизию",
      details: "Сохраните ревизию для следующего изменения. Незаполненный паспорт имеет ревизию 0.",
      examples: [
        [
          `npx @oim-dev/relay-cli ${kind} get${singleton ? "" : ` ${examples[kind]}`}`,
          "Прочитать запись",
        ],
      ],
      async run(context, input) {
        const data = await subject(
          context,
          kind,
          singleton ? "product:passport" : input.argument(),
        );
        const commands = {
          context: commandInvocation(context, ["inspect", "graph", "context", data.key]),
          ...(kind === "feature"
            ? { scenarios: commandInvocation(context, ["scenario", "list", "--feature", data.key]) }
            : {}),
          ...(kind === "product"
            ? { overview: commandInvocation(context, ["product", "overview"]) }
            : {}),
        };
        return { data, text: (options) => entityText(data, options, commands) };
      },
    });
    for (const action of ["create", "update"] as const)
      registerCommand<Options>(group, runtime, {
        name: action === "create" || singleton ? action : "update <ref>",
        ...(action === "update" && !singleton ? { arguments: { ref: "Ключ или ID записи" } } : {}),
        description: action === "create" ? "Создать запись" : "Изменить только указанные поля",
        details:
          "Markdown принимается текстом, из файла или stdin. Источники одного поля несовместимы. После потери ответа сначала прочитайте запись; автоматического повтора нет." +
          (kind === "implementation" && action === "create"
            ? " Для снятого участия той же пары приложение/цель Core возвращает прежний ID, но заменяет название, описание и совместимую отметку переданными значениями; без --status применяется none. Для возврата участия с сохранением содержания используйте application participation list/replace с прочитанными ревизией состава и версией продукта."
            : ""),
        examples: [
          [
            writeExample(kind, action),
            action === "create"
              ? "Создать запись с полным содержанием"
              : "Изменить название; замените ревизию прочитанным значением",
          ],
        ],
        configure: (command) => fieldOptions(command, kind, action === "create"),
        async run(context, input) {
          const fields = await readFields(context, input.options, kind, action === "create");
          const requestId = input.options.requestId ?? randomUUID();
          if (action === "create") {
            const command = parse(
              entityCreateSchema,
              { data: fields, requestId },
              "создание записи",
            );
            const data = await context.backend.entities.create(command, author(context));
            return {
              data,
              text: (options) =>
                entitySavedText(
                  data,
                  commandInvocation(context, [kind, "get", ...(singleton ? [] : [data.key])]),
                  options,
                ),
            };
          }
          const ref = singleton ? "product:passport" : input.argument();
          const command = parse(
            entityUpdateSchema,
            { ref, changes: fields, ifRevision: input.options.ifRevision, requestId },
            "изменение записи",
          );
          const data = await context.backend.entities.update(command, author(context));
          return {
            data,
            text: (options) =>
              entitySavedText(
                data,
                commandInvocation(context, [kind, "get", ...(singleton ? [] : [data.key])]),
                options,
              ),
          };
        },
      });
    registerCommand<{ ifRevision: number; requestId?: string }>(group, runtime, {
      name: singleton ? "rename <key>" : "rename <ref> <key>",
      arguments: singleton
        ? { key: "Новый читаемый ключ, не название" }
        : { ref: "Ключ или ID", key: "Новый читаемый ключ, не название" },
      description: "Изменить ключ с сохранением ID и алиасов",
      details: "Название меняется через update --name (у реализации --title).",
      examples: [[`npx @oim-dev/relay-cli ${kind} rename --help`, "Правила переименования"]],
      configure: revisionOption,
      async run(context, input) {
        const record = await subject(
          context,
          kind,
          singleton ? "product:passport" : input.argument(),
        );
        const data = await context.backend.entities.rename(
          {
            ref: `${kind}:${record.ref.id}`,
            key: input.argument(singleton ? 0 : 1),
            ifRevision: input.options.ifRevision,
            requestId: input.options.requestId ?? randomUUID(),
          },
          author(context),
        );
        return {
          data,
          text: (options) =>
            entitySavedText(
              data,
              commandInvocation(context, [kind, "get", ...(singleton ? [] : [data.key])]),
              options,
            ),
        };
      },
    });
    if (kind !== "document") registerEntityProgress(group, runtime, kind);
    if (kind === "document") {
      registerDocumentRelations(group, runtime);
      registerDocumentSections(group, runtime);
    }
    if (kind === "application") registerParticipation(group, runtime);
    if (kind === "product") registerProductReading(group, runtime);
  }
}

function registerProductReading(group: Command, runtime: Runtime) {
  registerCommand<{ limit?: number; cursor?: string }>(group, runtime, {
    name: "overview",
    description: "Прочитать карту продукта",
    details: "Постраничная карта; счётчики готовности относятся ко всему продукту.",
    examples: [["npx @oim-dev/relay-cli product overview", "Познакомиться с продуктом"]],
    configure: paging,
    async run(context, input) {
      const command = ["product", "overview"];
      const query = offsetQuery(context, input.options, command, {});
      const overview = await context.backend.product.overview();
      invariant(
        !query.version || query.version === overview.version,
        "VERSION_CONFLICT",
        "Продукт изменился. Начните overview без --cursor.",
      );
      const next = query.offset + query.limit;
      const items = overview.items.slice(query.offset, next);
      const data = {
        ...overview,
        items,
        readiness: overview.readiness.filter((entry) => items.some((item) => item.id === entry.id)),
        readinessCounts: {
          total: overview.readiness.length,
          ready: overview.readiness.filter((entry) => entry.status === "done").length,
          stale: overview.readiness.filter((entry) => entry.stale > 0).length,
        },
        total: overview.items.length,
        nextOffset: next < overview.items.length ? next : null,
      };
      return {
        data,
        page: pageResult(context, command, {}, query, data),
        text: (options) => productOverviewText(data, options),
      };
    },
  });
  registerCommand(group, runtime, {
    name: "validate",
    description: "Проверить целостность продукта",
    details: "Чтение с проверкой структурных инвариантов; не внешняя приёмка требований.",
    examples: [["npx @oim-dev/relay-cli product validate", "Проверить продукт"]],
    async run(context) {
      const state = await context.backend.product.state();
      return {
        data: { valid: true, records: state.records.length, version: state.version },
        text: (options) =>
          cardText(
            {
              title: "Структура продукта проверена",
              fields: [
                ["Проверено записей", state.records.length],
                ["Версия", state.version],
              ],
              sections: [
                {
                  title: "Границы проверки",
                  body: "Структурные инварианты соблюдены. Это не внешняя приёмка и не подтверждение полноты требований.",
                },
              ],
              commands: [
                {
                  label: "Проверить содержание",
                  command: commandInvocation(context, ["product", "lint"]),
                },
              ],
            },
            options,
          ),
      };
    },
  });
  registerCommand<{ id?: string; limit?: number; cursor?: string }>(group, runtime, {
    name: "lint",
    description: "Найти структурные недостатки описаний",
    details: "Рекомендации не изменяют записи и не доказывают полноту требований.",
    examples: [["npx @oim-dev/relay-cli product lint", "Прочитать рекомендации"]],
    configure: (command) => paging(command).option("--id <ref>", "Выбранная запись"),
    async run(context, input) {
      const command = ["product", "lint"];
      const filters = input.options.id ? { id: input.options.id } : {};
      const query = offsetQuery(context, input.options, command, filters);
      const state = await context.backend.product.state();
      invariant(
        !query.version || query.version === state.version,
        "VERSION_CONFLICT",
        "Продукт изменился. Начните lint без --cursor.",
      );
      const selected = filters.id ? await context.backend.product.entity(filters.id) : undefined;
      invariant(
        !selected || selected.fields.kind !== "implementation",
        "INVALID_ARGUMENT",
        "Для проверки реализаций запустите product lint без --id; отдельная реализация не поддержана контрактом lint.",
      );
      const data = {
        ...lintProduct(state, {
          ...(selected ? { id: selected.id } : {}),
          offset: query.offset,
          limit: query.limit,
        }),
        version: state.version,
      };
      return {
        data,
        page: pageResult(context, command, filters, query, { ...data, items: data.warnings }),
        text: (options) =>
          productLintText(
            data,
            options,
            filters,
            new Map(state.records.map((record) => [record.id, record.key ?? record.id])),
          ),
      };
    },
  });
}
