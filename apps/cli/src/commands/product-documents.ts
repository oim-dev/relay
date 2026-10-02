import { randomUUID } from "node:crypto";
import { InvalidArgumentError } from "commander";
import type { Command } from "commander";
import { entityUpdateSchema, defaultDocumentSections } from "@relay/contracts/entities";
import type { EntityDetail } from "@relay/contracts/entities";
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
import { collectTag, revisionOption, subject } from "./product.js";
import { entitySavedText } from "../presentation/entities.js";
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
function assertRevision(record: EntityDetail, revision: number) {
  invariant(
    record.revision === revision,
    "REVISION_CONFLICT",
    "Запись изменилась. Перечитайте её и согласуйте изменение; исходная ревизия не заменяется автоматически.",
    4,
    { actual: record.revision },
  );
}
async function update(
  context: CommandContext,
  record: EntityDetail,
  options: WriteOptions,
  changes: Record<string, unknown>,
  actionTitle?: string,
) {
  const command = parse(
    entityUpdateSchema,
    {
      ref: `${record.ref.kind}:${record.ref.id}`,
      ifRevision: options.ifRevision,
      requestId: options.requestId ?? randomUUID(),
      changes,
    },
    "изменение библиотеки",
  );
  const data = await context.backend.entities.update(command, author(context));
  const readCommand = commandInvocation(
    context,
    record.ref.kind === "project" ? ["document", "section", "list"] : ["document", "get", data.key],
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
    details: "relations и links показаны отдельно; пояснение относится к адресному отношению.",
    examples: [["npx @oim-dev/relay-cli document links DOC-1", "Прочитать прикрепления"]],
    configure: paging,
    async run(context, input) {
      const command = ["document", "links", input.argument()];
      const query = offsetQuery(context, input.options, command, {});
      const record = await subject(context, "document", input.argument());
      invariant(record.data.kind === "document", "INVALID_ARGUMENT", "Нужен документ");
      const version = `${record.ref.id}:${record.revision}`;
      invariant(
        !query.version || query.version === version,
        "VERSION_CONFLICT",
        "Документ изменился. Начните чтение links без --cursor.",
      );
      const links = [
        ...(record.data.relations ?? []).map((link) => ({
          source: "relations",
          target: link.target,
          type: link.type,
          description: link.description ?? "",
        })),
        ...record.data.links.map((link) => ({
          source: "links",
          target: { kind: link.kind, id: link.kind === "product" ? "passport" : link.id },
          type: "documents",
          description: "",
        })),
      ];
      const next = query.offset + query.limit;
      const data = {
        ref: record.ref,
        revision: record.revision,
        items: links.slice(query.offset, next),
        total: links.length,
        nextOffset: next < links.length ? next : null,
        version,
      };
      return {
        data,
        page: pageResult(context, command, {}, query, data),
        text: (options) =>
          cardText(
            {
              title: `Прикрепления ${record.key} — ${record.title}`,
              fields: [["Ревизия", record.revision]],
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
          nextRelation?: "references" | "documents";
        }
    >(group, runtime, {
      name: `${action} <ref>`,
      arguments: { ref: "Ключ или ID документа" },
      description:
        action === "link"
          ? "Прикрепить документ или изменить пояснение"
          : "Снять выбранное прикрепление",
      details:
        (action === "link"
          ? "Изменяет одну связь документа под его ревизией. Если связи цель+тип ещё нет, она прикрепляется (пояснение по умолчанию пустое; повтор даёт ALREADY_EXISTS). Если она есть — меняются только переданные поля: пояснение (--description/--description-file или --clear-description) и тип (--next-relation); пропущенное пояснение сохраняется. Совместимая область links с тем же адресом при явном изменении становится адресным отношением documents. Целью может быть сущность любого из 11 видов проекта."
          : "Снимает одну связь цель+тип (по умолчанию documents), включая совместимую область links; документ и цель сохраняются. Отсутствующая связь даёт RELATION_NOT_FOUND.") +
        " Остальные отношения и области сохраняются; Core проверяет ревизию и пишет рёбра графа в той же транзакции, при конфликте (REVISION_CONFLICT) запись не повторяется. --legacy изменяет прежние продуктовые области links/targets без пояснений через изменение документа.",
      examples: [
        [
          `npx @oim-dev/relay-cli document ${action} DOC-1 --target FEATURE-1 --if-revision 1 --actor agent`,
          "Изменить прикрепление по прочитанной ревизии",
        ],
        ...(action === "link"
          ? ([
              [
                "npx @oim-dev/relay-cli document link DOC-1 --target TASK-7 --relation references --next-relation documents --description 'Описывает итог задачи' --if-revision 2 --actor agent",
                "Сменить тип и пояснение существующей связи",
              ],
            ] as const)
          : []),
      ],
      configure(command) {
        revisionOption(command)
          .requiredOption("--target <ref>", "Ключ, ID или kind:ID цели")
          .option("--relation <type>", "Адресное отношение: references/documents")
          .option("--legacy", "Прежняя продуктовая область links/targets");
        if (action === "link") {
          textOption(command, "description", "Markdown-пояснение прикрепления");
          command
            .option("--clear-description", "Очистить пояснение отношения")
            .option(
              "--next-relation <type>",
              "Сменить тип существующего прикрепления на references/documents",
            );
        }
      },
      async run(context, input) {
        const options = input.options;
        const text = await readTextFields(
          context,
          options,
          action === "link" ? ["description"] : [],
        );
        invariant(
          !(options.clearDescription && text.description !== undefined),
          "INVALID_ARGUMENT",
          "Выберите пояснение или --clear-description",
        );
        invariant(
          !(
            options.legacy &&
            (options.relation !== undefined ||
              text.description !== undefined ||
              options.clearDescription ||
              options.nextRelation !== undefined)
          ),
          "INVALID_ARGUMENT",
          "Прежние области не принимают --relation, --next-relation и пояснение; используйте адресное отношение без --legacy",
        );
        const relation = options.relation ?? "documents";
        invariant(
          relation === "documents" || relation === "references",
          "INVALID_ARGUMENT",
          "Отношение: documents или references",
        );
        const record = await subject(context, "document", input.argument());
        invariant(record.data.kind === "document", "INVALID_ARGUMENT", "Нужен документ");
        assertRevision(record, options.ifRevision);
        const target = await context.backend.entities.resolve({ ref: options.target });
        if (options.legacy) {
          const targets = record.data.links.map(
            (link) => `${link.kind}:${link.kind === "product" ? "passport" : link.id}`,
          );
          const ref = `${target.ref.kind}:${target.ref.id}`;
          const exists = targets.includes(ref);
          invariant(
            action === "link" || exists,
            "INVALID_ARGUMENT",
            "Прежняя область не найдена; проверьте document links",
          );
          return update(
            context,
            record,
            options,
            {
              kind: "document",
              targets:
                action === "unlink"
                  ? targets.filter((value) => value !== ref)
                  : exists
                    ? targets
                    : [...targets, ref],
            },
            action === "link"
              ? `Прежняя область ${target.key} сохранена для документа`
              : `Прежняя область ${target.key} снята с документа`,
          );
        }
        const relations = record.data.relations ?? [];
        const legacyArea =
          relation === "documents" &&
          record.data.links.some(
            (link) =>
              link.kind === target.ref.kind &&
              (link.kind === "product" ? "passport" : link.id) === target.ref.id,
          );
        const existing =
          relations.some(
            (link) =>
              link.target.kind === target.ref.kind &&
              link.target.id === target.ref.id &&
              link.type === relation,
          ) || legacyArea;
        invariant(
          options.nextRelation === undefined || action === "link",
          "INVALID_ARGUMENT",
          "--next-relation применяется только в document link",
        );
        invariant(
          options.nextRelation === undefined ||
            options.nextRelation === "documents" ||
            options.nextRelation === "references",
          "INVALID_ARGUMENT",
          "Новое отношение: documents или references",
        );
        invariant(
          options.nextRelation === undefined || existing,
          "RELATION_NOT_FOUND",
          "--next-relation меняет тип существующего прикрепления; сначала прикрепите документ без него или проверьте document links",
          3,
        );
        // Одна связь меняется в Core под ревизией документа; остальные relations и links сохраняются.
        const description = options.clearDescription ? "" : text.description;
        const data = await context.backend.entities.relateDocument(
          {
            ref: `document:${record.ref.id}`,
            ifRevision: options.ifRevision,
            action: action === "unlink" ? "detach" : existing ? "update" : "attach",
            target: `${target.ref.kind}:${target.ref.id}`,
            type: relation,
            ...(action === "link" && description !== undefined ? { description } : {}),
            ...(options.nextRelation === undefined ? {} : { nextType: options.nextRelation }),
            requestId: options.requestId ?? randomUUID(),
          },
          author(context),
        );
        const readCommand = commandInvocation(context, ["document", "links", data.key]);
        const finalRelation = options.nextRelation ?? relation;
        return {
          data,
          text: (textOptions: import("../presentation/theme.js").TextOptions) =>
            entitySavedText(
              data,
              readCommand,
              textOptions,
              action === "unlink"
                ? `Отношение снято (${relation}, ${target.key}) для документа`
                : `${existing ? "Отношение изменено" : "Отношение прикреплено"} (${finalRelation}, ${target.key}) для документа`,
            ),
        };
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
      const project = await context.backend.entities.get({ ref: "PROJECT", kind: "project" });
      invariant(project.data.kind === "project", "INVALID_ARGUMENT", "Нужен проект");
      const version = `${project.ref.id}:${project.revision}`;
      invariant(
        !query.version || query.version === version,
        "VERSION_CONFLICT",
        "Разделы изменились. Начните list без --cursor.",
      );
      const sections = project.data.documentSections ?? defaultDocumentSections;
      const next = query.offset + query.limit;
      const data = {
        project: project.ref,
        revision: project.revision,
        items: sections.slice(query.offset, next),
        total: sections.length,
        nextOffset: next < sections.length ? next : null,
        version,
      };
      return {
        data,
        page: pageResult(context, command, {}, query, data),
        text: (options) =>
          listText(
            {
              title: "Разделы библиотеки",
              filters: [
                ["Проект", project.key],
                ["Ревизия проекта", project.revision],
              ],
              items: data.items.map((section) => ({ key: section.id, title: section.name })),
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
    registerCommand<WriteOptions & { name?: string; before?: string; last?: boolean }>(
      group,
      runtime,
      {
        name: `${action} <id>`,
        arguments: { id: "Постоянный ID раздела" },
        description: {
          create: "Создать раздел",
          update: "Переименовать раздел",
          move: "Переместить раздел",
          remove: "Удалить раздел, сохранив документы",
        }[action],
        details:
          "Передайте прочитанную ревизию проекта из document section list. Остальные разделы сохраняются; при конфликте операция не повторяется.",
        examples: [
          [`npx @oim-dev/relay-cli document section ${action} --help`, "Параметры изменения"],
        ],
        configure(command) {
          revisionOption(command);
          if (action === "create" || action === "update")
            command.requiredOption("--name <text>", "Название раздела");
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
          const project = await context.backend.entities.get({ ref: "PROJECT", kind: "project" });
          invariant(project.data.kind === "project", "INVALID_ARGUMENT", "Нужен проект");
          assertRevision(project, options.ifRevision);
          const sections = [...(project.data.documentSections ?? defaultDocumentSections)];
          const id = input.argument();
          const index = sections.findIndex((section) => section.id === id);
          invariant(
            action === "create" ? index === -1 : index !== -1,
            "INVALID_ARGUMENT",
            action === "create"
              ? "ID раздела уже существует"
              : "Раздел не найден; прочитайте document section list",
          );
          if (action === "create") sections.push({ id, name: options.name! });
          if (action === "update") sections[index] = { ...sections[index]!, name: options.name! };
          if (action === "remove") sections.splice(index, 1);
          if (action === "move") {
            invariant(
              options.before !== id,
              "INVALID_ARGUMENT",
              "Нельзя переместить раздел перед самим собой",
            );
            const [selected] = sections.splice(index, 1);
            const before = options.last
              ? sections.length
              : sections.findIndex((section) => section.id === options.before);
            invariant(before >= 0, "INVALID_ARGUMENT", "Целевой раздел не найден");
            sections.splice(before, 0, selected!);
          }
          return update(
            context,
            project,
            options,
            { kind: "project", documentSections: sections },
            `${{ create: "Создан раздел", update: "Переименован раздел", move: "Перемещён раздел", remove: "Удалён раздел" }[action]} ${id}; изменён проект`,
          );
        },
      },
    );
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
