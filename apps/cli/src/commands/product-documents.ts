import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { entityUpdateSchema, defaultDocumentSections } from "@relay/contracts/entities";
import type { EntityDetail } from "@relay/contracts/entities";
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
import { revisionOption, subject } from "./product.js";
import { entitySavedText } from "../presentation/entities.js";
import { renderMarkdown } from "../presentation/markdown.js";
import { cardText, listText } from "../presentation/common.js";

type PageOptions = { limit?: number; cursor?: string };
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
              options.clearDescription)
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
        const matches = (link: (typeof relations)[number]) =>
          link.target.kind === target.ref.kind &&
          link.target.id === target.ref.id &&
          link.type === relation;
        const old = relations.find(matches);
        invariant(
          action === "link" || old,
          "INVALID_ARGUMENT",
          "Адресное отношение не найдено; проверьте document links или --legacy",
        );
        const replacement = {
          target: target.ref,
          type: relation,
          description: options.clearDescription ? "" : (text.description ?? old?.description ?? ""),
        };
        const changed =
          action === "unlink"
            ? relations.filter((link) => !matches(link))
            : old
              ? relations.map((link) => (matches(link) ? replacement : link))
              : [...relations, replacement];
        return update(
          context,
          record,
          options,
          { kind: "document", relations: changed },
          `${action === "link" ? "Отношение сохранено" : "Отношение снято"} (${relation}, ${target.key}) для документа`,
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
