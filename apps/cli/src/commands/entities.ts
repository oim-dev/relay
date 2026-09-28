import type { Command } from "commander";
import { entityKindSchema } from "@relay/contracts/entities";
import type { EntitiesQuery, EntityKind } from "@relay/contracts/entities";
import { parse } from "@relay/core/domain/validation";
import { invariant } from "@relay/core/shared/errors";
import { commandGroup, registerCommand } from "../command.js";
import type { Runtime } from "../context.js";
import { paging, offsetQuery, pageResult, commandInvocation } from "../command-kit.js";
import {
  entitiesText,
  entityTypesText,
  entityTypeText,
  entityResolvedText,
  entityReadArgs,
} from "../presentation/entities.js";
import { listText } from "../presentation/common.js";

type PageOptions = { limit?: number; cursor?: string };

/** Поиск — пользовательский путь; inspect содержит только техническое чтение контрактов. */
export function registerEntities(program: Command, runtime: Runtime): void {
  registerCommand<Omit<EntitiesQuery, "limit"> & PageOptions>(program, runtime, {
    name: "search [text]",
    arguments: { text: "Текст поиска по ключу, ID, названию и описанию" },
    description: "Найти сущности проекта",
    details: "Фильтры применяются до пагинации. Полное содержание читайте через <вид> get <ключ>.",
    examples: [["npx @oim-dev/relay-cli search каталог --kind feature", "Найти требования"]],
    configure: (command) =>
      paging(command)
        .option("--q <text>", "Поиск; альтернатива позиционному тексту")
        .option("--kind <kind>", "Вид сущности")
        .option(
          "--refs <refs...>",
          "Выбранные ключи или ID",
          (value: string, previous: string[] = []) => [...previous, ...value.split(",")],
        )
        .option("--board <ref>", "Доска")
        .option("--application <ref>", "Приложение")
        .option("--feature <ref>", "Фича")
        .option("--scenario <ref>", "Сценарий")
        .option("--target <ref>", "Явная цель")
        .option("--parent <ref>", "Родитель задачи")
        .option("--status <status>", "Предметное состояние")
        .option("--active <value>", "Участие реализации: true/false")
        .option("--section <id>", "Раздел документов; none — без раздела")
        .option("--document-kind <kind>", "Тип документа")
        .option("--pinned <value>", "Закрепление: true/false")
        .option("--archived <value>", "Архив: true/false")
        .option("--sort <field>", "Сортировка: key/title/updated"),
    async run(context, input) {
      const { cursor: _cursor, limit: _limit, ...options } = input.options;
      invariant(
        !(options.q !== undefined && input.optionalArgument() !== undefined),
        "INVALID_ARGUMENT",
        "Выберите текст аргументом или --q",
      );
      const filters = { ...options, ...(input.optionalArgument() ? { q: input.argument() } : {}) };
      const command = ["search"];
      const query = offsetQuery(context, input.options, command, filters);
      const data = await context.backend.entities.list({ ...filters, ...query });
      return {
        data,
        page: pageResult(context, command, filters, query, data),
        text: (options) =>
          entitiesText(
            data,
            filters,
            options,
            data.items.map((item) => commandInvocation(context, entityReadArgs(item))),
          ),
      };
    },
  });
  const group = commandGroup(program, {
    name: "inspect",
    description: "Технические контракты, адреса и ключи",
    details: "Чтение без изменения данных. Обычные действия находятся в предметных командах.",
    examples: [["npx @oim-dev/relay-cli inspect types", "Узнать виды сущностей"]],
  });
  registerCommand<PageOptions>(group, runtime, {
    name: "types",
    description: "Прочитать каталог видов",
    details: "Назначение и поддерживаемые действия каждого вида.",
    examples: [["npx @oim-dev/relay-cli inspect types", "Прочитать каталог"]],
    configure: paging,
    async run(context, input) {
      const command = ["inspect", "types"];
      const query = offsetQuery(context, input.options, command, {});
      const data = await context.backend.entities.types(query);
      return {
        data,
        page: pageResult(context, command, {}, query, data),
        text: (options) =>
          entityTypesText(
            data,
            query,
            options,
            data.items.map((item) => commandInvocation(context, ["inspect", "type", item.kind])),
          ),
      };
    },
  });
  registerCommand(group, runtime, {
    name: "type <kind>",
    arguments: { kind: "Вид сущности" },
    description: "Прочитать поля и действия вида",
    details: "Отсутствующая схема означает отсутствие соответствующей общей операции.",
    examples: [["npx @oim-dev/relay-cli inspect type document", "Изучить документ"]],
    async run(context, input) {
      const data = await context.backend.entities.describe({
        kind: parse(entityKindSchema, input.argument(), "вид сущности"),
      });
      return {
        data,
        text: (options) =>
          entityTypeText(
            data,
            options,
            commandInvocation(context, [
              data.kind === "work-plan" ? "plan" : data.kind,
              data.kind === "product" || data.kind === "project" ? "get" : "list",
            ]),
          ),
      };
    },
  });
  registerCommand<{ kind?: EntityKind }>(group, runtime, {
    name: "resolve <ref>",
    arguments: { ref: "Ключ, алиас, ID или kind:ID" },
    description: "Разрешить постоянный адрес",
    details: "При неоднозначности уточните вид.",
    examples: [["npx @oim-dev/relay-cli inspect resolve FEATURE-1", "Получить ID"]],
    configure: (command) => command.option("--kind <kind>", "Ожидаемый вид"),
    async run(context, input) {
      const data = await context.backend.entities.resolve({
        ref: input.argument(),
        ...input.options,
      });
      return {
        data,
        text: (options) =>
          entityResolvedText(data, options, commandInvocation(context, entityReadArgs(data))),
      };
    },
  });
  for (const action of ["keys", "key-spaces"] as const)
    registerCommand<PageOptions>(group, runtime, {
      name: `${action} <${action === "keys" ? "ref" : "kind"}>`,
      arguments: action === "keys" ? { ref: "Ключ или ID" } : { kind: "Вид сущности" },
      description:
        action === "keys" ? "Прочитать текущий ключ и алиасы" : "Прочитать пространства нумерации",
      details: "Постраничное чтение согласованного снимка.",
      examples: [
        [
          `npx @oim-dev/relay-cli inspect ${action} ${action === "keys" ? "FEATURE-1" : "feature"}`,
          "Прочитать страницу",
        ],
      ],
      configure: paging,
      async run(context, input) {
        const command = ["inspect", action, input.argument()];
        const query = offsetQuery(context, input.options, command, {});
        if (action === "keys") {
          const data = await context.backend.entities.keys({ ref: input.argument(), ...query });
          return {
            data,
            page: pageResult(context, command, {}, query, data),
            text: (options) =>
              listText(
                {
                  title: `Ключи ${input.argument()}`,
                  items: data.items.map((item) => ({
                    key: item.key,
                    title: item.current ? "Текущий ключ" : "Прежний алиас",
                  })),
                  emptyMessage: "На этой странице ключей нет.",
                },
                options,
              ),
          };
        }
        const data = await context.backend.entities.keySpaces({
          kind: parse(entityKindSchema, input.argument(), "вид"),
          ...query,
        });
        return {
          data,
          page: pageResult(context, command, {}, query, data),
          text: (options) =>
            listText(
              {
                title: `Пространства ключей: ${input.argument()}`,
                items: data.items.map((item) => ({ key: item.pattern, title: item.title })),
                emptyMessage: "На этой странице пространств ключей нет.",
              },
              options,
            ),
        };
      },
    });
}
