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
  productOverviewCompactText,
  productOverviewMapText,
  productOverviewLegacyMapText,
} from "../presentation/product.js";
import type { ProductOverviewMetricView, ProductOverviewView } from "../presentation/product.js";
import {
  metricCommands,
  overviewCommands,
  productReadTokens,
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
const overviewCommand = ["overview"];
const overviewMetricsText = productOverviewMetrics.join(", ");

/** Детализация метрики: native cursor Backend связан с командой, метрикой, блокером и проектом. */
async function overviewMetric(context: CommandContext, options: OverviewOptions) {
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
  const controls = nativeQuery(context, options, overviewCommand, filters, "snapshot");
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
    page: nativePageResult(context, overviewCommand, filters, controls, page, "snapshot"),
    text: (format: Parameters<typeof productOverviewMetricText>[1]) =>
      productOverviewMetricText(data, format),
  };
}

export function registerOverview(program: Command, runtime: Runtime): void {
  registerCommand<OverviewOptions>(program, runtime, {
    name: "overview",
    description: "Обзор текущего состояния выбранного проекта",
    details:
      "Самостоятельный обзор одного проекта. В workspace выберите --project <имя> или используйте префикс <проект> overview; без выбора проекта команда не объединяет данные workspace. Последняя сессия и все незавершённые учитываются независимо от давности: compact показывает до 3 веток, full — до 5 с последними событиями; общий total сохраняется. При неполной подборке session list --unfinished читает все ветки.\n\n" +
      "Одно чтение согласованного среза: задачи по всем шести колонкам, проверка, блокеры с причинами, планы, релизы и продуктовые знания. По умолчанию text — компактная сводка без повторных карточек; --view full возвращает прежнее полное представление с подборками. --view map явно выбирает самостоятельную серверную страницу карты без сводки. --limit и --cursor листают карту; итоги обзора от них не зависят. Компактная сводка text не является страницей списка и не получает footer карты. Подборки полного режима — до 5 элементов с точными totals. Показатели пересекаются и не складываются. Обзор не меняет статусы и не решает, какую задачу начинать или завершать.\n\n" +
      "Показатели работы: очередь проверки по выполненным и оставшимся обязательствам, прямые блокеры незавершённой работы, работа in-progress и review вне открытых планов, незавершённая работа по доскам, открытые планы с выполненным составом, запланированные релизы с готовым составом и готовые завершённые планы вне релизов. Готовность обязательств позволяет рассмотреть завершение и не является внешней проверкой; работа вне открытых планов — сигнал, а не ошибка; блокеры считаются только напрямую.\n\n" +
      `--metric <метрика> переключает команду на полный постраничный список одного показателя: ${overviewMetricsText}. Для blocker-affected обязателен --blocker; для остальных метрик он запрещён. --view вместе с --metric не применяется. В метрике --limit и --cursor листают элементы показателя; total от размера страницы не зависит. --snapshot <snapshotVersion> привязывает первое чтение метрики или карты к срезу обзора; возьмите значение из поля «Срез». Без --snapshot первая страница читает актуальное состояние. Курсор сохраняет исходную версию, метрику, блокер, размер страницы, проект и транспорт; достаточно передать только --cursor. Изменение среза даёт VERSION_CONFLICT (exit 4): перечитайте overview без --cursor и --snapshot. Это guard текущих данных, не история. Глобальный --version по-прежнему показывает версию CLI; версия продуктового состава не заменяет snapshotVersion.`,
    examples: [
      ["npx @oim-dev/relay-cli overview", "Понять состояние проекта и выбрать чтение"],
      ["npx @oim-dev/relay-cli overview --project frontend", "Обзор выбранного проекта workspace"],
      ["npx @oim-dev/relay-cli frontend overview", "Тот же выбор проектным префиксом"],
      ["npx @oim-dev/relay-cli overview --view full", "Прочитать полный обзор с подборками"],
      ["npx @oim-dev/relay-cli overview --view map --limit 20", "Прочитать только страницу карты"],
      [
        "npx @oim-dev/relay-cli overview --view map --snapshot SNAPSHOT --limit 20",
        "Карта того же среза; замените SNAPSHOT значением поля «Срез» прочитанного обзора",
      ],
      [
        "npx @oim-dev/relay-cli overview --metric review-obligations-met",
        "Все задачи на проверке, завершение которых можно рассмотреть",
      ],
      [
        "npx @oim-dev/relay-cli overview --metric blocker-impact --limit 10",
        "Прямые блокеры: точные счётчики и команды состава",
      ],
      [
        "npx @oim-dev/relay-cli overview --metric blocker-affected --blocker PRODUCT-1",
        "Все задачи, которые PRODUCT-1 задерживает напрямую",
      ],
    ],
    configure: (command) =>
      paging(command)
        .option(
          "--view <mode>",
          "Представление: compact — сводка (по умолчанию), full — с подборками, map — только карта",
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
      return productSnapshotQuery(context, overviewCommand, async () => {
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
        const filters = { view: input.options.view, snapshot: input.options.snapshot };
        const query = offsetQuery(context, input.options, overviewCommand, filters);
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
            label: "Новый обзор проекта",
            command: commandInvocation(context, overviewCommand),
          });
          return {
            data,
            meta: { commands: [...commands.values()] },
            page: pageResult(context, overviewCommand, filters, query, {
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
          "Срез проекта изменился. Версия среза проверяет неизменность текущего состояния и не даёт доступа к историческому снимку. Начните overview заново без --cursor и --snapshot.",
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
                page: pageResult(context, overviewCommand, filters, query, {
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
}
