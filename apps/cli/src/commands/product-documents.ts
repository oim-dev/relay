import { randomUUID } from "node:crypto";
import { InvalidArgumentError } from "commander";
import type { Command } from "commander";
import { defaultDocumentSections } from "@relay/contracts/entities";
import type { EntitySaved } from "@relay/contracts/entities";
import { documentBulkSchema } from "@relay/contracts/entities/document-catalog";
import { parse } from "@relay/core/domain/validation";
import { invariant } from "@relay/core/shared/errors";
import { commandGroup, registerCommand } from "../command.js";
import { author } from "../context.js";
import type { CommandContext, Runtime } from "../context.js";
import {
  paging,
  offsetQuery,
  pageResult,
  textOption,
  readTextFields,
  commandInvocation,
} from "../command-kit.js";
import { collectTag, revisionOption } from "./product.js";
import { entitySavedText, entityReadArgs } from "../presentation/entities.js";
import { renderMarkdown } from "../presentation/markdown.js";
import { cardText, listText } from "../presentation/common.js";
import {
  documentBulkText,
  documentFacetsText,
  entityDocumentsText,
} from "../presentation/documents.js";

type PageOptions = { limit?: number; cursor?: string };

/**
 * Названия разделов только для text: отдельное чтение PROJECT, JSON остаётся с ID.
 * Неудачное чтение не скрывает основной результат — показываются ID.
 */
export async function documentSectionNames(
  context: CommandContext,
): Promise<Map<string, string> | undefined> {
  if (context.output.format === "json") return undefined;
  try {
    const project = await context.backend.entities.get({ ref: "PROJECT", kind: "project" });
    if (project.data.kind !== "project") return undefined;
    return new Map(
      (project.data.documentSections ?? defaultDocumentSections).map((section) => [
        section.id,
        section.name,
      ]),
    );
  } catch {
    return undefined;
  }
}
type WriteOptions = { ifRevision: number; requestId?: string };
function saved(context: CommandContext, data: EntitySaved, actionTitle?: string) {
  const readCommand = commandInvocation(
    context,
    data.ref.kind === "project" ? ["document", "section", "list"] : ["document", "get", data.key],
  );
  return {
    data,
    text: (options: import("../presentation/theme.js").TextOptions) =>
      entitySavedText(data, readCommand, options, actionTitle),
  };
}

export function registerDocumentRelations(group: Command, runtime: Runtime) {
  registerCommand<PageOptions>(group, runtime, {
    name: "links <ref>",
    arguments: { ref: "Ключ или ID документа" },
    description: "Прочитать отношения и прежние продуктовые области",
    details:
      "Собственные прикрепления документа: relations и links показаны отдельно, пояснения полностью. Это не все входящие рёбра: связи других записей читайте через inspect graph list --root. Подсказка чтения даётся для первой цели каждого вида на странице; для другой замените ключ или ID.",
    examples: [["npx @oim-dev/relay-cli document links DOC-1", "Прочитать прикрепления"]],
    configure: paging,
    async run(context, input) {
      const command = ["document", "links", input.argument()];
      const query = offsetQuery(context, input.options, command, {});
      const record = await context.backend.documents.links({ ref: input.argument(), ...query });
      // Заголовок и адресный словарь нужны только human; прежний машинный конверт сохраняется.
      const data = {
        ref: record.ref,
        revision: record.revision,
        items: record.items,
        total: record.total,
        nextOffset: record.nextOffset,
        version: record.version,
      };
      // Один пример чтения на вид цели, без повтора для двух типов отношения к одной записи.
      const targets = new Map(
        data.items.flatMap((link) => {
          // Этап не имеет самостоятельного get по одному ID; не выдумываем адрес команды.
          if (link.target.kind === "plan-stage") return [];
          const target = record.references.find(
            (item) => item.ref.kind === link.target.kind && item.ref.id === link.target.id,
          ) ?? { ref: { kind: link.target.kind, id: link.target.id }, key: link.target.id };
          return [[`${link.target.kind}:${link.target.id}`, target] as const];
        }),
      );
      const seenKinds = new Set<string>();
      const readCommands = [...targets.values()]
        .filter((target) => {
          if (seenKinds.has(target.ref.kind)) return false;
          seenKinds.add(target.ref.kind);
          return true;
        })
        .map((target) => ({
          label:
            target.ref.kind === "product" || target.ref.kind === "project"
              ? `Прочитать ${target.key}`
              : `Прочитать ${target.key}; для другой цели этого вида замените ключ/ID`,
          command: commandInvocation(context, entityReadArgs(target)),
        }));
      return {
        data,
        page: pageResult(context, command, {}, query, data),
        text: (options) =>
          cardText(
            {
              title: `Прикрепления ${record.key} — ${record.title}`,
              fields: [["Ревизия", record.revision]],
              commands: [
                ...readCommands,
                {
                  label: "Все направления связей, включая прикрепления других записей",
                  command: commandInvocation(context, [
                    "inspect",
                    "graph",
                    "list",
                    "--root",
                    record.key,
                  ]),
                },
              ],
              sections: data.items.length
                ? data.items.map((link) => {
                    const target = record.references.find(
                      (item) =>
                        item.ref.kind === link.target.kind && item.ref.id === link.target.id,
                    );
                    return {
                      title: `${link.source === "links" ? "Прежняя область (links)" : link.type === "documents" ? "Документ описывает (documents)" : "Цель ссылается на документ (references)"} → ${target ? `${target.key} — ${target.title}` : `${link.target.kind}:${link.target.id} (название не предоставлено)`}`,
                      body: link.description
                        ? renderMarkdown(link.description, options)
                        : "Пояснение не задано.",
                    };
                  })
                : [
                    {
                      title: "Отношения",
                      body:
                        data.total === 0
                          ? "Прикреплений нет."
                          : "На этой странице прикреплений нет.",
                    },
                  ],
            },
            options,
          ),
      };
    },
  });
  for (const action of ["link", "unlink"] as const)
    registerCommand<
      WriteOptions &
        Record<string, unknown> & {
          target: string;
          relation?: "references" | "documents";
          legacy?: boolean;
          clearDescription?: boolean;
        }
    >(group, runtime, {
      name: `${action} <ref>`,
      arguments: { ref: "Ключ или ID документа" },
      description:
        action === "link"
          ? "Прикрепить документ или изменить пояснение"
          : "Снять выбранное прикрепление",
      details:
        "Одно изменение документа с исходной ревизией; цель разрешает Core. Остальные отношения и области сохраняются. --legacy выбирает прежние продуктовые области без пояснений; по умолчанию адресное отношение documents." +
        (action === "unlink"
          ? " Связь с прежним адресом этапа (plan-stage:<id>) снимается по сохранённой цели."
          : " Прежний адрес этапа (plan-stage:<id>) получает ENTITY_RELOCATED с новым адресом."),
      examples: [
        [
          `npx @oim-dev/relay-cli document ${action} DOC-1 --target FEATURE-1 --if-revision 1 --actor agent`,
          "Изменить прикрепление по прочитанной ревизии",
        ],
      ],
      configure(command) {
        revisionOption(command)
          .requiredOption("--target <ref>", "Ключ, ID или kind:ID цели")
          .option("--relation <type>", "Адресное отношение: references/documents")
          .option("--legacy", "Прежняя продуктовая область links/targets");
        if (action === "link") {
          textOption(command, "description", "Markdown-пояснение прикрепления");
          command.option("--clear-description", "Очистить пояснение отношения");
        }
      },
      async run(context, input) {
        const options = input.options;
        const hasDescription =
          options.description !== undefined || options.descriptionFile !== undefined;
        invariant(
          !(options.clearDescription && hasDescription),
          "INVALID_ARGUMENT",
          "Выберите пояснение или --clear-description",
        );
        invariant(
          !(
            options.legacy &&
            (options.relation !== undefined || hasDescription || options.clearDescription)
          ),
          "INVALID_ARGUMENT",
          "Прежние области не принимают --relation и пояснение; используйте адресное отношение без --legacy",
        );
        const relation = options.relation ?? "documents";
        invariant(
          relation === "documents" || relation === "references",
          "INVALID_ARGUMENT",
          "Отношение: documents или references",
        );
        const text = await readTextFields(
          context,
          options,
          action === "link" ? ["description"] : [],
        );
        const base = {
          ref: input.argument(),
          target: options.target,
          ifRevision: options.ifRevision,
          requestId: options.requestId ?? randomUUID(),
        };
        const description = options.clearDescription ? "" : text.description;
        const data = await context.backend.documents.changeRelation(
          options.legacy
            ? { ...base, source: "links", action }
            : action === "unlink"
              ? { ...base, source: "relations", action, relation }
              : {
                  ...base,
                  source: "relations",
                  action,
                  relation,
                  ...(description === undefined ? {} : { description }),
                },
          author(context),
        );
        return saved(
          context,
          data,
          options.legacy
            ? `Прежняя область ${options.target} ${action === "link" ? "сохранена для документа" : "снята с документа"}`
            : `${action === "link" ? "Отношение сохранено" : "Отношение снято"} (${relation}, ${options.target}) для документа`,
        );
      },
    });
}
export function registerDocumentSections(parent: Command, runtime: Runtime) {
  const group = commandGroup(parent, {
    name: "section",
    description: "Разделы библиотеки документов",
    details: "Ревизия относится к PROJECT, не к документу. Изменение массива разделов атомарно.",
    examples: [
      ["npx @oim-dev/relay-cli document section list", "Прочитать разделы и ревизию проекта"],
    ],
  });
  registerCommand<PageOptions>(group, runtime, {
    name: "list",
    description: "Прочитать разделы в их порядке",
    details: "Сохраните ревизию проекта для изменения разделов.",
    examples: [["npx @oim-dev/relay-cli document section list", "Прочитать разделы"]],
    configure: paging,
    async run(context, input) {
      const command = ["document", "section", "list"];
      const query = offsetQuery(context, input.options, command, {});
      const project = await context.backend.documents.sections(query);
      const data = {
        project: project.project,
        revision: project.revision,
        items: project.items,
        total: project.total,
        nextOffset: project.nextOffset,
        version: project.version,
      };
      return {
        data,
        page: pageResult(context, command, {}, query, data),
        text: (options) =>
          listText(
            {
              title: "Разделы библиотеки",
              filters: [
                ["Проект", project.projectKey],
                ["Ревизия проекта", project.revision],
              ],
              items: data.items.map((section) => ({ key: section.id, title: section.name })),
              commands: [
                {
                  label: data.items[0]
                    ? `Документы раздела ${data.items[0].id}; для другого замените ID (none — без раздела)`
                    : "Документы без раздела",
                  command: commandInvocation(context, [
                    "document",
                    "list",
                    "--section",
                    data.items[0]?.id ?? "none",
                  ]),
                },
              ],
              emptyMessage:
                data.total === 0
                  ? "Разделов нет. Документы без раздела читаются отдельно."
                  : "На этой странице разделов нет.",
            },
            options,
          ),
      };
    },
  });
  for (const action of ["create", "update", "move", "remove"] as const)
    registerCommand<
      WriteOptions & { name?: string; nameFile?: string; before?: string; last?: boolean }
    >(group, runtime, {
      name: `${action} <id>`,
      arguments: { id: "Постоянный ID раздела" },
      description: {
        create: "Создать раздел",
        update: "Переименовать раздел",
        move: "Переместить раздел",
        remove: "Удалить раздел, сохранив документы",
      }[action],
      details:
        "Передайте прочитанную ревизию проекта из document section list. Остальные разделы сохраняются; при конфликте операция не повторяется. Для create/update обязателен --name либо --name-file (UTF-8 файл; - означает stdin). Источники несовместимы; ввод читается до записи.",
      examples: [
        [`npx @oim-dev/relay-cli document section ${action} --help`, "Параметры изменения"],
      ],
      configure(command) {
        revisionOption(command);
        if (action === "create" || action === "update")
          textOption(command, "name", "Название раздела");
        if (action === "move")
          command
            .option("--before <id>", "Поставить перед разделом")
            .option("--last", "Поставить в конец");
      },
      async run(context, input) {
        const options = input.options;
        if (action === "move")
          invariant(
            (options.before !== undefined) !== Boolean(options.last),
            "INVALID_ARGUMENT",
            "Укажите ровно один параметр: --before или --last",
          );
        const text = await readTextFields(
          context,
          options,
          action === "create" || action === "update" ? ["name"] : [],
        );
        if (action === "create" || action === "update")
          invariant(
            text.name !== undefined,
            "INVALID_ARGUMENT",
            "Укажите название раздела через --name или --name-file",
          );
        const id = input.argument();
        const base = {
          id,
          ifRevision: options.ifRevision,
          requestId: options.requestId ?? randomUUID(),
        };
        const data = await context.backend.documents.changeSection(
          action === "create" || action === "update"
            ? { ...base, action, name: text.name! }
            : action === "move"
              ? { ...base, action, before: options.last ? null : options.before! }
              : { ...base, action },
          author(context),
        );
        return saved(
          context,
          data,
          `${{ create: "Создан раздел", update: "Переименован раздел", move: "Перемещён раздел", remove: "Удалён раздел" }[action]} ${id}; изменён проект`,
        );
      },
    });
}

type CatalogFilters = {
  q?: string;
  target?: string;
  section?: string;
  tag?: string[];
  documentFormat?: string;
  documentKind?: string;
  status?: string;
  pinned?: string;
  archived?: string;
  unattached?: string;
};
const bulkStatuses = "applied, unchanged, conflict, not_found, invalid, error";
const bulkExitRule =
  "Код выхода: 0 — у всех элементов applied или unchanged; 1 — частичный или полный отказ (хотя бы один conflict, not_found, invalid или error), при этом полный поэлементный результат всё равно печатается в stdout (в JSON — ok:true и data.items). Ошибка самого запроса (неверные параметры, подключение) — обычная ошибка с её кодом без результата.";

/** ref@revision: ревизия после последнего @, ключи и ID не содержат @. */
function bulkItem(value: string, previous: { ref: string; ifRevision: number }[] = []) {
  const at = value.lastIndexOf("@");
  const ref = at > 0 ? value.slice(0, at) : "";
  const revision = at > 0 ? value.slice(at + 1) : "";
  if (!ref || !/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision)))
    throw new InvalidArgumentError(
      "Ожидается <ключ или ID>@<ревизия>, например DOC-1@3; ревизию берите из document get или list",
    );
  return [...previous, { ref, ifRevision: Number(revision) }];
}

/** Каталог библиотеки: счётчики, массовые операции и обратное чтение материалов сущности. */
export function registerDocumentCatalog(group: Command, runtime: Runtime) {
  registerCommand<CatalogFilters>(group, runtime, {
    name: "facets",
    description: "Счётчики каталога по разделам, тегам, форматам, типам и состояниям",
    details:
      "Считает по полным данным проекта, а не по странице списка. Фильтры те же, что у document list. Каждая ось считается по всем фильтрам, кроме собственного (состояния — без --status и --archived); счётчик тега — размер выборки после добавления этого тега. Представления (все, закреплённые, черновики, без раздела, без прикреплений, архив) учитывают только --q, --target, --tag, --document-format и --document-kind; все, кроме архива, исключают архивные документы. Версия совпадает с version списка. Только чтение.",
    examples: [
      ["npx @oim-dev/relay-cli document facets", "Счётчики всей библиотеки"],
      [
        "npx @oim-dev/relay-cli document facets --tag API --section architecture --format json",
        "Счётчики выборки для навигации агента",
      ],
    ],
    configure: (command) =>
      command
        .option("--q <text>", "Поиск по ключу, названию, описанию, содержанию, адресу и тегам")
        .option("--target <ref>", "Прикрепление к сущности")
        .option("--section <id>", "Раздел; none — без раздела")
        .option("--tag <tag>", "Тег; повторите флаг — нужны все выбранные теги", collectTag)
        .option("--document-format <format>", "Формат: markdown/link")
        .option("--document-kind <kind>", "Тип документа")
        .option("--status <state>", "Состояние: draft/active/archived")
        .option("--pinned <value>", "Закрепление: true/false")
        .option("--archived <value>", "Архив: true/false")
        .option("--unattached <value>", "Без прикреплений: true/false"),
    async run(context, input) {
      const { tag, ...rest } = input.options;
      const query = { ...rest, ...(tag === undefined ? {} : { tags: tag }) };
      const data = await context.backend.entities.documentFacets(
        query as Parameters<typeof context.backend.entities.documentFacets>[0],
      );
      const list = [
        "document",
        "list",
        ...Object.entries(input.options).flatMap(([name, value]) =>
          value === undefined
            ? []
            : (Array.isArray(value) ? value : [value]).flatMap((item) => [
                `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
                String(item),
              ]),
        ),
      ];
      const sections = await documentSectionNames(context);
      return {
        data,
        text: (options) =>
          documentFacetsText(
            data,
            query,
            options,
            [{ label: "Список выборки", command: commandInvocation(context, list) }],
            sections,
          ),
      };
    },
  });

  const bulk = commandGroup(group, {
    name: "bulk",
    description: "Массовые изменения выбранных документов",
    details: `Одно действие для 1–100 документов. Каждый документ передаётся как --item <ключ или ID>@<прочитанная ревизия> и записывается отдельно под своей ревизией: набор не атомарен, отказ одного не откатывает сохранённые, автоматических повторов нет. Прикрепления не меняются. Статусы элементов: ${bulkStatuses}. ${bulkExitRule} После частичного отказа перечитайте только документы с отказом; при conflict сверьте актуальное содержание, а не подставляйте новую ревизию.`,
    examples: [
      [
        "npx @oim-dev/relay-cli document bulk status --item DOC-1@3 --item DOC-2@1 --document-status archived --actor agent",
        "Архивировать два документа",
      ],
    ],
  });
  const operations = {
    move: {
      description: "Переместить в раздел или оставить без раздела",
      example: "--section-id architecture",
      configure: (command: Command) =>
        command
          .option("--section-id <id>", "ID существующего раздела")
          .option("--clear-section", "Оставить без раздела"),
    },
    "add-tags": {
      description: "Добавить теги к существующим",
      example: "--tag API --tag Решения",
      configure: (command: Command) =>
        command.requiredOption(
          "--tag <tag>",
          "Тег; повторяйте флаг. Повтор без учёта регистра не дублируется; больше 20 тегов — invalid",
          collectTag,
        ),
    },
    "remove-tags": {
      description: "Снять теги без учёта регистра",
      example: "--tag Устарело",
      configure: (command: Command) =>
        command.requiredOption("--tag <tag>", "Тег; повторяйте флаг", collectTag),
    },
    status: {
      description: "Изменить состояние: draft/active/archived",
      example: "--document-status archived",
      configure: (command: Command) =>
        command.requiredOption("--document-status <state>", "Состояние: draft/active/archived"),
    },
    pin: {
      description: "Закрепить или открепить",
      example: "--pinned true",
      configure: (command: Command) =>
        command.requiredOption("--pinned <value>", "true — закрепить, false — открепить"),
    },
  } as const;
  for (const [name, operation] of Object.entries(operations) as [
    keyof typeof operations,
    (typeof operations)[keyof typeof operations],
  ][])
    registerCommand<{
      item: { ref: string; ifRevision: number }[];
      requestId?: string;
      sectionId?: string;
      clearSection?: boolean;
      tag?: string[];
      documentStatus?: string;
      pinned?: string;
    }>(bulk, runtime, {
      name,
      description: operation.description,
      details: `Каждый --item — <ключ или ID>@<ревизия>; от 1 до 100 без повторов. Результат по каждому элементу в порядке запроса: ${bulkStatuses}; при conflict показана актуальная ревизия. ${bulkExitRule}`,
      examples: [
        [
          `npx @oim-dev/relay-cli document bulk ${name} --item DOC-1@3 --item DOC-2@1 ${operation.example} --actor agent`,
          operation.description,
        ],
      ],
      configure(command) {
        command.requiredOption(
          "--item <ref@revision>",
          "Документ и прочитанная ревизия, например DOC-1@3; повторяйте флаг",
          bulkItem,
        );
        operation.configure(command);
        command.option("--request-id <id>", "Корреляция, не гарантия безопасного повтора");
      },
      async run(context, input) {
        const options = input.options;
        if (name === "move")
          invariant(
            (options.sectionId !== undefined) !== Boolean(options.clearSection),
            "INVALID_ARGUMENT",
            "Укажите ровно один параметр: --section-id или --clear-section",
          );
        if (name === "pin")
          invariant(
            options.pinned === "true" || options.pinned === "false",
            "INVALID_ARGUMENT",
            "Укажите --pinned true или false",
          );
        const command = parse(
          documentBulkSchema,
          {
            items: options.item,
            operation:
              name === "move"
                ? { type: "move", sectionId: options.clearSection ? null : options.sectionId }
                : name === "add-tags"
                  ? { type: "addTags", tags: options.tag }
                  : name === "remove-tags"
                    ? { type: "removeTags", tags: options.tag }
                    : name === "status"
                      ? { type: "setStatus", documentStatus: options.documentStatus }
                      : { type: "pin", pinned: options.pinned === "true" },
            requestId: options.requestId ?? randomUUID(),
          },
          "массовое изменение документов",
        );
        const data = await context.backend.entities.documentBulk(command, author(context));
        // Перечитать можно только найденный документ; not_found не получает команды.
        const readCommands = Object.fromEntries(
          data.items.flatMap((item) =>
            item.key ? [[item.ref, commandInvocation(context, ["document", "get", item.key])]] : [],
          ),
        );
        return {
          data,
          ...(data.failed > 0 ? { exitCode: 1 } : {}),
          text: (textOptions) =>
            documentBulkText(data, `${name} (${operation.description})`, textOptions, readCommands),
        };
      },
    });

  registerCommand<{ archived?: string; limit?: number; cursor?: string }>(group, runtime, {
    name: "materials <ref>",
    arguments: { ref: "Ключ, ID или kind:ID сущности любого из 11 видов проекта" },
    description: "Материалы, прикреплённые к сущности",
    details:
      "Обратное чтение: какие документы прикреплены напрямую к выбранной сущности (project, product, feature, scenario, application, implementation, board, task, document, work-plan, release). Материалы родителя не попадают к детям и наоборот. Для каждого документа показаны все его связи с этой сущностью: тип, полное пояснение и источник — адресное отношение relations или совместимая область links. Архивные документы по умолчанию включены с отметкой; --archived false исключает их, true — только архив. Порядок: закреплённые, затем по названию. Продолжение проверяет версию каталога.",
    examples: [
      ["npx @oim-dev/relay-cli document materials FEATURE-1", "Что читать по фиче"],
      [
        "npx @oim-dev/relay-cli document materials PROJECT --archived false --format json",
        "Действующие материалы проекта для агента",
      ],
    ],
    configure: (command) =>
      paging(command).option(
        "--archived <value>",
        "Архив: true — только архив, false — без архива; по умолчанию все",
      ),
    async run(context, input) {
      const ref = input.argument();
      const command = ["document", "materials", ref];
      const filters =
        input.options.archived === undefined ? {} : { archived: input.options.archived };
      const query = offsetQuery(context, input.options, command, filters);
      const data = await context.backend.entities.entityDocuments({
        ref,
        ...(filters as { archived?: "true" | "false" }),
        ...query,
      });
      const readCommands = data.items.map((item) =>
        commandInvocation(context, ["document", "get", item.document.key]),
      );
      const sections = await documentSectionNames(context);
      return {
        data,
        page: pageResult(context, command, filters, query, data),
        text: (options) => entityDocumentsText(data, options, readCommands, sections),
      };
    },
  });
}
