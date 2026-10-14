import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import type { EntitySaved } from "@relay/contracts/entities";
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
import { revisionOption } from "./product.js";
import { entitySavedText, entityReadArgs } from "../presentation/entities.js";
import { renderMarkdown } from "../presentation/markdown.js";
import { cardText, listText } from "../presentation/common.js";

type PageOptions = { limit?: number; cursor?: string };
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
        "Одно изменение документа с исходной ревизией. Остальные отношения и области сохраняются. --legacy выбирает прежние продуктовые области без пояснений; по умолчанию адресное отношение documents.",
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
