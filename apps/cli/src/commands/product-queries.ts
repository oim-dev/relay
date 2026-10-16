import type { Command } from "commander";
import { registerCommand } from "../command.js";
import type { Runtime } from "../context.js";
import { paging, offsetQuery, pageResult, commandInvocation } from "../command-kit.js";
import { productLintText, productStateText, productContextText } from "../presentation/product.js";
import { cardText } from "../presentation/common.js";
import {
  productReadTokens,
  productRecordCommands,
  productSnapshotQuery,
} from "./product-query-helpers.js";

export function registerProductReading(group: Command, runtime: Runtime): void {
  registerCommand(group, runtime, {
    name: "state",
    description: "Прочитать полное согласованное состояние продукта",
    details:
      "Все продуктовые агрегаты с полными текстами, составами приложений и готовностью за одно чтение. Без страниц и усечения. Это не состояние всех задач проекта, не граф и не исторический снимок. Для краткой сводки проекта используйте overview; для одной записи — предметный get.",
    examples: [
      ["npx @oim-dev/relay-cli product state", "Прочитать все продуктовые данные одним срезом"],
    ],
    async run(context) {
      const data = await context.backend.product.state();
      const commands = productRecordCommands(context, data.records);
      commands.push({
        label: "Обзор проекта",
        command: commandInvocation(context, ["overview"]),
      });
      return {
        data,
        meta: {
          completeness: { selection: "product-state", complete: true, graph: false },
          commands,
        },
        text: (options) => productStateText(data, options, commands),
      };
    },
  });
  registerCommand<{ id?: string; application?: string }>(group, runtime, {
    name: "context",
    description: "Прочитать предметный контекст выбранной продуктовой области",
    details:
      "Паспорт, общие требования, приложения, реализации и связанные прежними продуктовыми областями документы с причинами включения. --id выбирает запись (в том числе FI/SI); --application ограничивает реализации приложением. Без фильтров — паспорт и документы с прежней областью продукта, не весь продукт. Полный ответ предметной подборки без страниц; состав scope ограничен выбранной областью. Это не обход современных relations и не замена inspect graph context. Для всего продуктового состояния используйте product state.",
    examples: [
      [
        "npx @oim-dev/relay-cli product context --id FEATURE-1",
        "Прочитать основания и реализации фичи",
      ],
      [
        "npx @oim-dev/relay-cli product context --id WEB",
        "Прочитать требования выбранного приложения",
      ],
    ],
    configure: (command) =>
      command
        .option("--id <ref>", "ID, ключ или алиас продуктовой записи, включая реализацию")
        .option("--application <ref>", "Ограничить реализации ID, ключом или алиасом приложения"),
    async run(context, input) {
      const data = await context.backend.product.context({
        ...(input.options.id === undefined ? {} : { id: input.options.id }),
        ...(input.options.application === undefined
          ? {}
          : { applicationId: input.options.application }),
      });
      const commands = productRecordCommands(
        context,
        data.records.map(({ record }) => record),
      );
      commands.push({
        label: "Всё состояние продукта",
        command: commandInvocation(context, ["product", "state"]),
      });
      return {
        data,
        meta: {
          completeness: {
            selection: "product-context",
            complete: true,
            graph: false,
            scope: "selected-contracts",
            filters: input.options,
          },
          commands,
        },
        text: (options) => productContextText(data, options, commands, input.options),
      };
    },
  });
  registerCommand(group, runtime, {
    name: "validate",
    description: "Проверить целостность продукта",
    details: "Чтение с проверкой структурных инвариантов; не внешняя приёмка требований.",
    examples: [["npx @oim-dev/relay-cli product validate", "Проверить продукт"]],
    async run(context) {
      const data = await context.backend.product.validate();
      return {
        data,
        text: (options) =>
          cardText(
            {
              title: "Структура продукта проверена",
              fields: [
                ["Проверено записей", data.records],
                ["Версия", data.version, "opaque"],
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
    details:
      "Рекомендации не изменяют записи и не доказывают полноту требований. --id принимает публичный ключ, ID или алиас записи, включая FI/SI. Полный счётчик замечаний не зависит от страницы; продолжение сохраняет версию продукта. При VERSION_CONFLICT (exit 4) начните без --cursor.",
    examples: [["npx @oim-dev/relay-cli product lint", "Прочитать рекомендации"]],
    configure: (command) => paging(command).option("--id <ref>", "Выбранная запись"),
    async run(context, input) {
      const command = ["product", "lint"];
      const filters = input.options.id ? { id: input.options.id } : {};
      const query = offsetQuery(context, input.options, command, filters);
      return productSnapshotQuery(
        context,
        [...command, ...(filters.id ? ["--id", filters.id] : [])],
        async () => {
          const page = await context.backend.product.lint({
            ...query,
            ...(filters.id ? { ref: filters.id } : {}),
          });
          // Прежние id/name остаются для сохранённых JSON-потребителей; публичный ref и технический recordId раздельны.
          const data = {
            ...page,
            warnings: page.warnings.map((entry) => ({
              ...entry,
              id: entry.recordId,
              name: entry.title,
            })),
          };
          const commands = new Map<string, { label: string; command: string }>();
          for (const entry of page.warnings)
            if (!commands.has(entry.ref.kind))
              commands.set(entry.ref.kind, {
                label: `Открыть ${entry.key} (пример; остальные ключи указаны выше)`,
                command: commandInvocation(context, productReadTokens(entry.ref.kind, entry.key)),
              });
          if (!commands.size)
            commands.set("read", {
              label: filters.id ? "Прочитать предметный контекст записи" : "Обзор проекта",
              command: commandInvocation(
                context,
                filters.id ? ["product", "context", "--id", filters.id] : ["overview"],
              ),
            });
          return {
            data,
            page: pageResult(context, command, filters, query, { ...data, items: data.warnings }),
            meta: { commands: [...commands.values()] },
            text: (options) => productLintText(data, options, filters, [...commands.values()]),
          };
        },
      );
    },
  });
}
