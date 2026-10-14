import { Option, type Command } from "commander";
import { z } from "zod";
import {
  saveReleaseByRefsSchema,
  updateReleaseByRefsSchema,
  releasesQuerySchema,
  releasesCompactQuerySchema,
  releaseActionSchema,
  releasePreviewSchema,
  releasePreviewCompactSchema,
  releaseCompositionCompactQuerySchema,
} from "@relay/contracts/releases";
import { parse } from "@relay/core/domain/validation";
import { AppError } from "@relay/core/shared/errors";
import { commandGroup, registerCommand } from "../command.js";
import { author } from "../context.js";
import type { CommandContext, Runtime } from "../context.js";
import { PresentedError } from "../output.js";
import {
  paging,
  offsetQuery,
  pageResult,
  textOption,
  readTextFields,
  commandInvocation,
} from "../command-kit.js";
import { registerEntityProgress } from "./progress.js";
import {
  planningListText,
  planningSavedText,
  planningStatusLabels,
  releaseText,
  releaseErrorText,
} from "../presentation/planning.js";
import {
  details,
  refArgument,
  writing,
  revision,
  filtersOf,
  metadata,
} from "./planning-release-shared.js";
import type { Options } from "./planning-release-shared.js";

const projection = (command: Command) =>
  command.addOption(
    new Option(
      "--projection <mode>",
      "Явная обзорная проекция без полных текстов; по умолчанию прежний полный DTO",
    ).choices(["compact"]),
  );

/** Отказ не повторяет запись и не подставляет новую ревизию в прежнее тело. */
async function releaseWrite<T>(
  context: CommandContext,
  selection: { ref?: string; plans?: string[] },
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const incomplete = error.code === "RELEASE_INCOMPLETE";
    const conflict = error.code === "REVISION_CONFLICT" && selection.ref !== undefined;
    if (!incomplete && !conflict) throw error;
    const tokens = conflict
      ? ["release", "get", selection.ref!]
      : selection.plans
        ? ["release", "preview", "--plans", ...selection.plans]
        : ["release", "progress", selection.ref!];
    const next = conflict
      ? "Перечитайте релиз и сравните сохранённые данные со своим изменением. Согласуйте новый ввод; не подставляйте свежую ревизию автоматически и не повторяйте прежнюю запись вслепую."
      : selection.plans
        ? "Проверьте выбранный для записи состав без сохранения. Завершите планы и их текущие обязательства; предпросмотр не фиксирует выпуск."
        : "Прочитайте текущий прогресс релиза и причины неготовности. Завершите планы и их обязательства, затем заново проверьте состояние перед выпуском.";
    throw new PresentedError(error.code, error.message, error.exitCode, error.details, (options) =>
      releaseErrorText(
        error,
        next,
        [
          {
            label: conflict
              ? "Прочитать релиз"
              : selection.plans
                ? "Проверить выбранные планы"
                : "Разобрать неготовность",
            command: commandInvocation(context, tokens),
          },
        ],
        options,
      ),
    );
  }
}

/** Релизные команды передают значимые параметры напрямую, без непрозрачного JSON-запроса. */
export function registerReleases(program: Command, runtime: Runtime): void {
  const group = commandGroup(program, {
    name: "release",
    description: "Самостоятельные релизы, актуальный состав и готовность",
    details,
    examples: [["npx @oim-dev/relay-cli release list", "Прочитать релизы проекта"]],
  });
  registerEntityProgress(group, runtime, "release");
  registerCommand<Options>(group, runtime, {
    name: "list",
    description: "Каталог релизов с готовностью",
    details: "Полные итоги независимы от страницы; продолжение сохраняет фильтры и версию.",
    examples: [["npx @oim-dev/relay-cli release list --limit 12", "Прочитать первую страницу"]],
    configure: (command) =>
      projection(paging(command))
        .option("--q <text>", "Поиск по ключу, названию, версии, краткому и полному описанию")
        .option("--status <status>", "Состояние релиза: planned, released, cancelled"),
    run: async (context, input) => {
      const command = ["release", "list"];
      const filters = filtersOf(input.options);
      const query = offsetQuery(context, input.options, command, filters);
      const data =
        filters.projection === "compact"
          ? await context.backend.releases.listCompact(
              parse(releasesCompactQuerySchema, { ...filters, ...query }, "обзор релизов"),
            )
          : await context.backend.releases.list(
              parse(releasesQuerySchema, { ...filters, ...query }, "каталог релизов"),
            );
      return {
        data,
        page: pageResult(context, command, filters, query, data),
        text: (options) =>
          planningListText(
            "Релизы",
            ["Ключ", "Название", "Версия", "Состояние", "Готово сейчас"],
            data.items.map((item) => [
              item.key,
              item.title,
              item.version,
              planningStatusLabels[item.status]!,
              `${item.readiness.ready}/${item.readiness.total}`,
            ]),
            data,
            "release list",
            filters,
            options,
            context.globals,
            [
              {
                label: data.items[0]
                  ? "Прочитать релиз; для другой записи замените ключ/ID"
                  : "Параметры поиска релизов",
                command: commandInvocation(
                  context,
                  data.items[0]
                    ? ["release", "get", data.items[0].key]
                    : ["release", "list", "--help"],
                ),
              },
            ],
          ),
      };
    },
  });
  registerCommand(group, runtime, {
    name: "get <reference>",
    description: "Полные тексты и актуальное состояние",
    arguments: refArgument,
    details:
      "Полное содержание отображается как Markdown; состав имеет отдельные постраничные команды.",
    examples: [["npx @oim-dev/relay-cli release get REL-1", "Прочитать запись"]],
    run: async (context, input) => {
      const data = await context.backend.releases.get(input.argument());
      const commands = {
        plans: commandInvocation(context, ["release", "plans", data.key]),
        progress: commandInvocation(context, ["release", "progress", data.key]),
        documents: commandInvocation(context, ["document", "list", "--target", data.key]),
      };
      return { data, text: (options) => releaseText(data, options, commands) };
    },
  });
  registerCommand<Options>(group, runtime, {
    name: "preview",
    description: "Проверить выбранные планы без записи релиза",
    details:
      "Состав задаётся явно; готовность вычисляет Core. Пустой выбор не является готовым выпуском.",
    examples: [
      [
        "npx @oim-dev/relay-cli release preview --plans PLN-1 PLN-2",
        "Узнать готовность будущего состава",
      ],
    ],
    configure: (command) =>
      projection(paging(command)).option(
        "--plans <references...>",
        "Ключи или ID выбранных планов, максимум 200",
      ),
    run: async (context, input) => {
      const command = ["release", "preview"];
      const filters: Record<string, unknown> = {
        projection: input.options.projection,
        plans:
          input.options.plans === undefined
            ? undefined
            : z
                .array(z.string())
                .parse(input.options.plans)
                .flatMap((value) => value.split(",")),
      };
      const query = offsetQuery(context, input.options, command, filters);
      const data =
        filters.projection === "compact"
          ? await context.backend.releases.previewCompact(
              parse(
                releasePreviewCompactSchema,
                { ...query, projection: "compact", plans: filters.plans ?? [] },
                "обзор состава релиза",
              ),
            )
          : await context.backend.releases.preview(
              parse(
                releasePreviewSchema,
                { ...query, plans: filters.plans ?? [] },
                "предпросмотр релиза",
              ),
            );
      return {
        data,
        page: pageResult(context, command, filters, query, data),
        text: (options) =>
          planningListText(
            `Предпросмотр без записи · текущая готовность: ${data.readiness.ready}/${data.readiness.total} планов${data.readiness.total ? "" : " · состав не выбран, выпуск не готов"}`,
            ["Ключ", "Название", "Состояние", "Задачи сейчас"],
            data.items.map(({ id, plan }) => [
              plan?.key ?? id,
              plan?.title ?? "План недоступен",
              plan ? planningStatusLabels[plan.status]! : "Недоступен",
              plan ? `${plan.counts.completed}/${plan.counts.total}` : "—",
            ]),
            data,
            "release preview",
            filters,
            options,
            context.globals,
            [
              ...(data.items.find((item) => item.plan)?.plan
                ? [
                    {
                      label: "Прочитать план; для другой записи замените ключ/ID",
                      command: commandInvocation(context, [
                        "plan",
                        "get",
                        data.items.find((item) => item.plan)!.plan!.key,
                      ]),
                    },
                  ]
                : []),
              { label: "Выбрать планы", command: commandInvocation(context, ["plan", "list"]) },
            ],
          ),
      };
    },
  });
  for (const action of ["create", "update"] as const)
    registerCommand<Options>(group, runtime, {
      name: action === "create" ? "create" : "update <reference>",
      description:
        action === "create"
          ? "Создать релиз с выбранными планами"
          : "Изменить реквизиты, состав и состояние релиза",
      details,
      ...(action === "update" ? { arguments: refArgument } : {}),
      examples: [
        [
          `npx @oim-dev/relay-cli release ${action}${action === "update" ? " REL-1 --if-revision 1" : ""} --actor human --title "Первый выпуск" --release-version 0.1 --plans PLN-1`,
          "Сохранить релиз",
        ],
      ],
      configure: (command) => {
        if (action === "create")
          writing(command)
            .requiredOption("--title <title>", "Название релиза")
            .requiredOption("--release-version <label>", "Обозначение версии выпуска")
            .requiredOption("--plans <references...>", "Планы состава по ключам или ID");
        else
          revision(command)
            .option("--title <title>", "Название релиза")
            .option("--release-version <label>", "Обозначение версии выпуска")
            .option("--plans <references...>", "Полный новый состав планов");
        textOption(command, "summary", "Краткое описание");
        textOption(
          command,
          "description",
          "Полное описание релиза в Markdown: содержание выпуска, значимые изменения, ограничения и основания поставки",
        );
        command
          .option("--planned-for <date>", "Плановая дата YYYY-MM-DD; пустая строка очищает дату")
          .option(
            "--status <status>",
            "planned, cancelled или released; released фиксирует выпуск",
          );
      },
      run: async (context, input) => {
        const texts = await readTextFields(context, input.options, ["summary", "description"]);
        const previous =
          action === "update" ? await context.backend.releases.get(input.argument()) : undefined;
        const options = { ...input.options, ...texts };
        const plans =
          options.plans === undefined
            ? previous?.planIds
            : z.array(z.string()).parse(options.plans);
        const command = parse(
          saveReleaseByRefsSchema,
          {
            ...metadata(options),
            title: options.title ?? previous?.title,
            version: options.releaseVersion ?? previous?.version,
            summary: options.summary ?? previous?.summary,
            description: options.description ?? previous?.description,
            plannedFor: options.plannedFor ?? previous?.plannedFor,
            status: options.status ?? previous?.status,
            plans,
          },
          "сохранение релиза",
        );
        const data = await releaseWrite(
          context,
          {
            ...(action === "update" ? { ref: input.argument() } : {}),
            ...(options.plans === undefined
              ? {}
              : { plans: z.array(z.string()).parse(options.plans) }),
          },
          () =>
            action === "create"
              ? context.backend.releases.createByRefs(command, author(context))
              : context.backend.releases.updateByRefs(
                  input.argument(),
                  updateReleaseByRefsSchema.parse(command),
                  author(context),
                ),
        );
        return {
          data,
          text: (options) =>
            planningSavedText(data, options, [
              {
                label: "Прочитать релиз",
                command: commandInvocation(context, ["release", "get", data.key]),
              },
            ]),
        };
      },
    });
  for (const action of ["plan", "cancel", "publish"] as const)
    registerCommand<Options>(group, runtime, {
      name: `${action} <reference>`,
      description: {
        plan: "Перепланировать отменённый релиз",
        cancel: "Отменить плановый релиз",
        publish: "Зафиксировать выпуск выбранных планов",
      }[action],
      details,
      arguments: refArgument,
      examples: [
        [
          `npx @oim-dev/relay-cli release ${action} REL-1 --actor human --if-revision 1`,
          "Изменить состояние выпуска",
        ],
      ],
      configure: revision,
      run: async (context, input) => {
        const data = await releaseWrite(context, { ref: input.argument() }, () =>
          context.backend.releases.transition(
            input.argument(),
            parse(
              releaseActionSchema,
              { ...metadata(input.options), action: action === "publish" ? "release" : action },
              "переход релиза",
            ),
            author(context),
          ),
        );
        return {
          data,
          text: (options) =>
            planningSavedText(data, options, [
              {
                label: "Прочитать релиз",
                command: commandInvocation(context, ["release", "get", data.key]),
              },
            ]),
        };
      },
    });
  registerCommand<Options>(group, runtime, {
    name: "plans <reference>",
    description: "Актуальные планы выбранного состава",
    details:
      "Страницы имеют версию и явное продолжение. Готовность отражает текущие задачи даже после выпуска.",
    arguments: refArgument,
    examples: [["npx @oim-dev/relay-cli release plans REL-1 --limit 12", "Прочитать страницу"]],
    configure: (command) => projection(paging(command)),
    run: async (context, input) => {
      const command = ["release", "plans", input.argument()];
      const filters: Record<string, unknown> = { projection: input.options.projection };
      const query = offsetQuery(context, input.options, command, filters);
      const data =
        filters.projection === "compact"
          ? await context.backend.releases.compositionCompact(
              input.argument(),
              parse(
                releaseCompositionCompactQuerySchema,
                { ...query, ...filters },
                "обзор планов релиза",
              ),
            )
          : await context.backend.releases.composition(input.argument(), query);
      return {
        data,
        page: pageResult(context, command, filters, query, data),
        text: (options) =>
          planningListText(
            `Планы релиза ${input.argument()} · текущая готовность: ${data.readiness.ready}/${data.readiness.total}`,
            ["Ключ", "Название", "Состояние", "Задачи сейчас"],
            data.items.map(({ id, plan }) => [
              plan?.key ?? id,
              plan?.title ?? "План недоступен",
              plan ? planningStatusLabels[plan.status]! : "Недоступен",
              plan ? `${plan.counts.completed}/${plan.counts.total}` : "—",
            ]),
            data,
            `release plans ${input.argument()}`,
            filters,
            options,
            context.globals,
            [
              ...(data.items.find((item) => item.plan)?.plan
                ? [
                    {
                      label: "Прочитать план; для другой записи замените ключ/ID",
                      command: commandInvocation(context, [
                        "plan",
                        "get",
                        data.items.find((item) => item.plan)!.plan!.key,
                      ]),
                    },
                  ]
                : []),
              {
                label: "Прочитать релиз",
                command: commandInvocation(context, ["release", "get", input.argument()]),
              },
            ],
          ),
      };
    },
  });
}
