import type { Command } from "commander";
import { productOverviewMetrics } from "@relay/contracts/entities/product";
import type { ProductOverviewMetric } from "@relay/contracts/entities/product";
import { invariant } from "@relay/core/shared/errors";
import { registerCommand } from "../command.js";
import type { CommandContext, Runtime } from "../context.js";
import {
  paging,
  offsetQuery,
  pageResult,
  commandInvocation,
  nativeQuery,
  nativePageResult,
  cursorType,
} from "../command-kit.js";
import {
  productOverviewText,
  productOverviewMetricText,
  productLintText,
  productOverviewCompactText,
  productOverviewMapText,
  productOverviewLegacyMapText,
  productStateText,
  productContextText,
} from "../presentation/product.js";
import type { ProductOverviewMetricView, ProductOverviewView } from "../presentation/product.js";
import { cardText } from "../presentation/common.js";
import {
  metricCommands,
  overviewCommands,
  productReadTokens,
  productRecordCommands,
  productSnapshotQuery,
} from "./product-query-helpers.js";

type OverviewOptions = {
  limit?: number;
  cursor?: string;
  metric?: string;
  blocker?: string;
  snapshot?: string;
  view?: string;
};
const overviewMetricsText = productOverviewMetrics.join(", ");

/** Детализация метрики оператора: native cursor Backend связан с командой, метрикой, блокером и проектом. */
async function overviewMetric(context: CommandContext, options: OverviewOptions) {
  const command = ["product", "overview"];
  invariant(
    options.view === undefined,
    "INVALID_ARGUMENT",
    "--view не применяется вместе с --metric",
  );
  const filters = {
    metric: options.metric,
    blocker: options.blocker,
    snapshot: options.snapshot,
  };
  const controls = nativeQuery(context, options, command, filters, "snapshot");
  const page = await context.backend.product.overviewMetric({
    // Неизвестную метрику и лишний/отсутствующий блокер отклоняет Backend одинаково в local и HTTP.
    metric: filters.metric as ProductOverviewMetric,
    ...(filters.blocker === undefined ? {} : { blocker: filters.blocker }),
    limit: controls.limit,
    ...(controls.cursor === undefined ? {} : { cursor: controls.cursor }),
    ...(filters.snapshot === undefined ? {} : { version: filters.snapshot }),
  });
  const commands = metricCommands(context, page);
  const data: ProductOverviewMetricView = { ...page, commands };
  return {
    data,
    page: nativePageResult(context, command, filters, controls, page, "snapshot"),
    text: (format: Parameters<typeof productOverviewMetricText>[1]) =>
      productOverviewMetricText(data, format),
  };
}

export function registerProductReading(group: Command, runtime: Runtime): void {
  registerCommand(group, runtime, {
    name: "state",
    description: "Прочитать полное согласованное состояние продукта",
    details:
      "Все продуктовые агрегаты с полными текстами, составами приложений и готовностью за одно чтение. Без страниц и усечения. Это не состояние всех задач проекта, не граф и не исторический снимок. JSON сохраняет полный DTO Backend.",
    examples: [
      [
        "npx @oim-dev/relay-cli product state --format json",
        "Прочитать все продуктовые данные одним срезом",
      ],
    ],
    async run(context) {
      const data = await context.backend.product.state();
      const commands = productRecordCommands(context, data.records);
      commands.push({
        label: "Обзор продукта",
        command: commandInvocation(context, ["product", "overview"]),
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
  registerCommand<OverviewOptions>(group, runtime, {
    name: "overview",
    description: "Обзор состояния продукта и проекта",
    details:
      "Одно чтение согласованного среза: задачи по всем шести колонкам, проверка, блокеры с причинами, планы, релизы и продуктовые знания. По умолчанию text — компактная сводка без повторных карточек; --view full возвращает прежнее полное представление с подборками. JSON в обоих режимах сохраняет полный DTO обзора и страницу прежней карты. --view map явно выбирает самостоятельную серверную страницу карты без сводки (также отдельный компактный DTO в JSON). --limit и --cursor листают карту; итоги обзора от них не зависят. Компактная сводка text не является страницей списка и не получает footer карты. Подборки полного режима — до 5 элементов с точными totals. Показатели пересекаются и не складываются. Обзор не меняет статусы и не решает, какую задачу начинать или завершать.\n\n" +
      "Показатели работы: очередь проверки по выполненным и оставшимся обязательствам, прямые блокеры незавершённой работы, работа in-progress и review вне открытых планов, незавершённая работа по доскам, открытые планы с выполненным составом, запланированные релизы с готовым составом и готовые завершённые планы вне релизов. Готовность обязательств позволяет рассмотреть завершение и не является внешней проверкой; работа вне открытых планов — сигнал, а не ошибка; блокеры считаются только напрямую.\n\n" +
      `--metric <метрика> переключает команду на полный постраничный список одного показателя: ${overviewMetricsText}. Для blocker-affected обязателен --blocker; для остальных метрик он запрещён. --view вместе с --metric не применяется. В метрике --limit и --cursor листают элементы показателя; total от размера страницы не зависит. --snapshot <snapshotVersion> привязывает первое чтение метрики или карты к срезу обзора; возьмите значение из поля «Срез» text или data.snapshotVersion JSON. Без --snapshot первая страница читает актуальное состояние. Курсор сохраняет исходную версию, метрику, блокер, размер страницы, проект и транспорт; достаточно передать только --cursor. Изменение среза даёт VERSION_CONFLICT (exit 4): перечитайте overview без --cursor и --snapshot. Это guard текущих данных, не история. Глобальный --version по-прежнему показывает версию CLI; поле data.version — версия продуктового состава, не snapshotVersion.`,
    examples: [
      ["npx @oim-dev/relay-cli product overview", "Понять состояние продукта и выбрать чтение"],
      [
        "npx @oim-dev/relay-cli product overview --view full",
        "Прочитать прежний полный обзор с подборками",
      ],
      [
        "npx @oim-dev/relay-cli product overview --view map --limit 20",
        "Прочитать только страницу карты",
      ],
      [
        "npx @oim-dev/relay-cli product overview --limit 20 --format json",
        "Полный машинный срез и первые 20 записей карты",
      ],
      [
        "npx @oim-dev/relay-cli product overview --metric review-obligations-met",
        "Все задачи на проверке, завершение которых можно рассмотреть",
      ],
      [
        "npx @oim-dev/relay-cli product overview --metric blocker-impact --limit 10 --format json",
        "Прямые блокеры: точные счётчики и команды состава",
      ],
      [
        "npx @oim-dev/relay-cli product overview --metric blocker-affected --blocker PRODUCT-1",
        "Все задачи, которые PRODUCT-1 задерживает напрямую",
      ],
    ],
    configure: (command) =>
      paging(command)
        .option(
          "--view <mode>",
          "Представление: compact (text по умолчанию), full или map; JSON compact/full остаётся полным",
        )
        .option(
          "--snapshot <snapshot>",
          "Отпечаток snapshotVersion прочитанного обзора; не версия CLI и не история",
        )
        .option("--metric <metric>", `Полный список показателя: ${overviewMetricsText}`)
        .option(
          "--blocker <task>",
          "ID или ключ задачи-блокера; только с --metric blocker-affected",
        ),
    async run(context, input) {
      // Курсор детализации сам восстанавливает метрику и блокер: достаточно одного --cursor.
      return productSnapshotQuery(context, ["product", "overview"], async () => {
        invariant(
          input.options.snapshot !== "",
          "INVALID_ARGUMENT",
          "--snapshot ожидает непустой snapshotVersion обзора",
        );
        if (input.options.metric !== undefined || cursorType(input.options.cursor) === "native")
          return overviewMetric(context, input.options);
        invariant(
          input.options.blocker === undefined,
          "INVALID_ARGUMENT",
          "--blocker применяется только вместе с --metric blocker-affected",
        );
        const command = ["product", "overview"];
        const filters = { view: input.options.view, snapshot: input.options.snapshot };
        const query = offsetQuery(context, input.options, command, filters);
        invariant(
          filters.view === undefined || ["compact", "full", "map"].includes(filters.view),
          "INVALID_ARGUMENT",
          "--view: ожидается compact, full или map",
        );
        const version = query.version ?? filters.snapshot;
        if (filters.view === "map") {
          const data = await context.backend.product.overviewMap({
            ...query,
            ...(version === undefined ? {} : { version }),
          });
          const commands = new Map<string, { label: string; command: string }>();
          for (const item of data.items)
            if (!commands.has(item.kind))
              commands.set(item.kind, {
                label:
                  item.kind === "scope"
                    ? `Состав ${item.subject.key}`
                    : `Открыть ${item.subject.key}`,
                command: commandInvocation(context, productReadTokens(item.kind, item.subject.key)),
              });
          commands.set("overview", {
            label: "Новый обзор",
            command: commandInvocation(context, command),
          });
          return {
            data,
            meta: { commands: [...commands.values()] },
            page: pageResult(context, command, filters, query, {
              ...data,
              version: data.snapshotVersion,
            }),
            text: (options) => productOverviewMapText(data, options, [...commands.values()]),
          };
        }
        const overview = await context.backend.product.overview();
        invariant(
          version === undefined || version === overview.snapshotVersion,
          "VERSION_CONFLICT",
          "Срез проекта изменился. Версия среза проверяет неизменность текущего состояния и не даёт доступа к историческому снимку. Начните product overview заново без --cursor и --snapshot.",
          4,
        );
        const next = query.offset + query.limit;
        const items = overview.items.slice(query.offset, next);
        const commands = overviewCommands(context, overview);
        const data: ProductOverviewView = {
          ...overview,
          items,
          readiness: overview.readiness.filter((entry) =>
            items.some((item) => item.id === entry.id),
          ),
          readinessCounts: {
            total: overview.readiness.length,
            ready: overview.readiness.filter((entry) => entry.status === "done").length,
            stale: overview.readiness.filter((entry) => entry.stale > 0).length,
          },
          total: overview.items.length,
          nextOffset: next < overview.items.length ? next : null,
          commands,
        };
        return {
          data,
          // Продолжение карты защищает полный срез; прежний version в data не подменяется.
          ...(context.output.format === "json" || filters.view === "full" || query.offset > 0
            ? {
                page: pageResult(context, command, filters, query, {
                  items,
                  total: data.total,
                  nextOffset: data.nextOffset,
                  version: overview.snapshotVersion,
                }),
              }
            : {}),
          text: (options) =>
            query.offset > 0
              ? productOverviewLegacyMapText(data, options, query.offset)
              : filters.view === "full"
                ? productOverviewText(data, options, query.offset)
                : productOverviewCompactText(data, options),
        };
      });
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
              label: filters.id ? "Прочитать предметный контекст записи" : "Обзор продукта",
              command: commandInvocation(
                context,
                filters.id ? ["product", "context", "--id", filters.id] : ["product", "overview"],
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
