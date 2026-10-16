import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { z } from "zod";
import {
  createPlanSchema,
  updatePlanSchema,
  transitionPlanSchema,
  changeStageSchema,
  changePlanTasksSchema,
  transferPlanTaskSchema,
  plansQuerySchema,
  plansCompactQuerySchema,
  planningPageQuerySchema,
  workPlanFieldsSchema,
  stageFieldsSchema,
  planningCandidatesQuerySchema,
  workPlanDataSchema,
} from "@relay/contracts/planning";
import { parse } from "@relay/core/domain/validation";
import { commandGroup, registerCommand, type CommandDefinition } from "../command.js";
import { author } from "../context.js";
import type { Runtime, CommandContext } from "../context.js";
import { integer } from "../options.js";
import { AppError } from "@relay/core/shared/errors";
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
  planningSavedText,
  planningStatusLabels,
  planningColumnLabel,
  stageText,
} from "../presentation/planning.js";
import {
  planCardText,
  planListText,
  planCountFields,
  planPresentedError,
} from "../presentation/plans.js";

import { registerReleases } from "./releases.js";
import {
  details,
  refArgument,
  writing,
  revision,
  filtersOf,
  metadata,
} from "./planning-release-shared.js";
import type { Options } from "./planning-release-shared.js";

async function planFields(context: CommandContext, options: Options) {
  if (options.participants !== undefined && options.clearParticipants)
    throw new AppError(
      "CONFLICTING_OPTIONS",
      "--participants и --clear-participants нельзя использовать вместе",
      2,
    );
  if (options.scope !== undefined && options.clearScope)
    throw new AppError("INVALID_ARGUMENT", "--scope и --clear-scope нельзя использовать вместе", 2);
  const texts = await readTextFields(context, options, [
    "summary",
    "goal",
    "rationale",
    "boundaries",
    "expectedResult",
  ]);
  const fields = Object.fromEntries(
    Object.keys(workPlanFieldsSchema.shape)
      .filter((key) => options[key] !== undefined && key !== "scope")
      .map((key) => [key, options[key]]),
  );
  Object.assign(fields, texts);
  if (options.scope !== undefined)
    fields.scope = await Promise.all(
      z
        .array(z.string())
        .parse(options.scope)
        .map(async (ref) => (await context.backend.entities.resolve({ ref })).ref),
    );
  if (options.clearScope) fields.scope = [];
  if (options.clearParticipants) fields.participants = [];
  return fields;
}
const contentOptions = (command: Command) => {
  for (const [name, label] of [
    ["summary", "Краткая аннотация обычным текстом"],
    [
      "goal",
      "Полная цель в Markdown: зачем изменение, что должно получиться; не краткая аннотация",
    ],
    ["rationale", "Обоснование в Markdown: проблема, источники и причины выбранной работы"],
    ["boundaries", "Границы в Markdown: что входит в изменение и что исключено"],
    ["expected-result", "Ожидаемый результат в Markdown: наблюдаемые изменения и способ проверки"],
  ])
    textOption(command, name!, label!);
  return command
    .option("--scope <references...>", "Области воздействия: ключи или kind:ID")
    .option("--clear-scope", "Явно очистить область изменения")
    .option("--participants <actors...>", "Участники плана; заменяет весь набор")
    .option("--clear-participants", "Явно очистить участников; несовместимо с --participants");
};

function registerPlanCommand<Options extends object = Record<string, never>>(
  parent: Command,
  runtime: Runtime,
  definition: CommandDefinition<Options>,
): void {
  registerCommand<Options>(parent, runtime, {
    ...definition,
    async run(context, input) {
      try {
        return await definition.run(context, input);
      } catch (error) {
        const options = input.options as Record<string, unknown>;
        const action = definition.name.split(" ")[0]!;
        const taskGroup = parent.name() === "task" && parent.parent?.name() === "plan";
        const stageGroup = parent.name() === "stage" || parent.parent?.name() === "stage";
        throw planPresentedError(error, {
          action,
          plan: taskGroup
            ? typeof options.plan === "string"
              ? options.plan
              : undefined
            : input.optionalArgument(),
          stage: stageGroup && action !== "transfer" ? input.optionalArgument(1) : undefined,
          task:
            taskGroup && action === "memberships"
              ? input.optionalArgument()
              : action === "transfer"
                ? input.optionalArgument(1)
                : Array.isArray(options.tasks)
                  ? options.tasks[0]
                  : undefined,
          targetPlan: typeof options.targetPlan === "string" ? options.targetPlan : undefined,
          invoke: (args) => commandInvocation(context, args),
        });
      }
    },
  });
}

/** Предметные команды планирования; форматирование отделено от Core. */
export function registerPlanning(program: Command, runtime: Runtime): void {
  const plan = commandGroup(program, {
    name: "plan",
    description: "Планы работ, этапы и состав задач",
    details: `Создайте draft через create, добавьте этапы и существующие задачи через stage. start начинает план; complete/cancel закрывают его с итогом или причиной. Закрытый план доступен только для чтения. Готовность и причины — progress. ${details}`,
    examples: [["npx @oim-dev/relay-cli plan list", "Прочитать планы проекта"]],
  });
  registerReleases(program, runtime);
  const stage = commandGroup(plan, {
    name: "stage",
    description: "Этапы плана: содержание, порядок и задачи",
    details,
    examples: [["npx @oim-dev/relay-cli plan stage list PLN-1", "Прочитать этапы"]],
  });
  const stageTask = commandGroup(stage, {
    name: "task",
    description: "Состав задач этапа",
    details,
    examples: [["npx @oim-dev/relay-cli plan stage task list PLN-1 Ab12Cd34", "Прочитать задачи"]],
  });
  const planTask = commandGroup(plan, {
    name: "task",
    description: "Поиск задач и участие в планах",
    details,
    examples: [["npx @oim-dev/relay-cli plan task candidates", "Найти задачи"]],
  });
  registerEntityProgress(plan, runtime, "work-plan");
  registerPlanCommand<Options>(planTask, runtime, {
    name: "candidates",
    description: "Найти задачи для включения в этап",
    details:
      "Доступность, доска и поиск применяются до пагинации. Состав выбранного этапа остаётся видимым.",
    examples: [
      [
        "npx @oim-dev/relay-cli plan task candidates --available-only true",
        "Прочитать свободные задачи",
      ],
    ],
    configure: (command) =>
      paging(command)
        .option("--q <text>", "Поиск по ключу и названию")
        .option("--board <reference>", "Доска: slug, ключ или ID")
        .option("--plan <reference>", "План редактируемого этапа: ключ или ID")
        .option("--stage <id>", "Внутренний ID этапа; требует --plan")
        .option(
          "--available-only <value>",
          "true — доступные задачи, false — также занятые и отменённые",
        ),
    run: async (context, input) => {
      const command = ["plan", "task", "candidates"];
      const filters = filtersOf(input.options);
      const query = offsetQuery(context, input.options, command, filters);
      const request = parse(planningCandidatesQuerySchema, { ...filters, ...query }, "выбор задач");
      const data = await context.backend.plans.candidates(request);
      return {
        data,
        page: pageResult(context, command, filters, query, data),
        text: (options) =>
          planListText(
            "Задачи для плана",
            data.items.map((item) => ({
              key: item.key,
              title: item.title,
              fields: [
                ["Колонка", planningColumnLabel(item.column)],
                ["Выполнена", item.completed ? "Да" : "Нет"],
                ["Заблокирована", item.blocked ? "Да" : "Нет"],
                ["Готова к работе", item.ready ? "Да" : "Нет"],
                ["Текущий план", item.assignment?.planKey ?? "Без текущего плана", "opaque"],
                ...(item.assignment
                  ? ([
                      ["Состояние плана", planningStatusLabels[item.assignment.status]],
                      ["Этап", item.assignment.stageTitle],
                      ["ID этапа", item.assignment.stageId, "opaque"],
                    ] as const)
                  : []),
              ],
            })),
            { ...filters, availableOnly: request.availableOnly },
            options,
            data.items[0]
              ? [
                  {
                    label: "Задача — пример для первого ключа; подставьте выбранный ключ",
                    command: commandInvocation(context, ["task", "get", data.items[0].key]),
                  },
                  {
                    label: "Участие выбранной задачи — пример для первого ключа",
                    command: commandInvocation(context, [
                      "plan",
                      "task",
                      "memberships",
                      data.items[0].key,
                    ]),
                  },
                ]
              : [],
          ),
      };
    },
  });
  registerPlanCommand<Options>(plan, runtime, {
    name: "list",
    description: "Каталог планов с прогрессом",
    details:
      "Полные итоги независимы от страницы; продолжение сохраняет фильтры, проекцию и версию. --projection compact получает обзор без полных Markdown-полей соседних планов. Полное содержание читается через plan get.",
    examples: [
      ["npx @oim-dev/relay-cli plan list --limit 12", "Прочитать первую страницу"],
      [
        "npx @oim-dev/relay-cli plan list --projection compact",
        "Получить явный обзор без полных текстов соседних планов",
      ],
    ],
    configure: (command) =>
      paging(command)
        .option("--q <text>", "Поиск по ключу, названию и описанию")
        .option("--status <status>", "Состояние плана: draft, active, completed или cancelled")
        .option(
          "--projection <projection>",
          "compact — явный обзор без полных текстов; по умолчанию прежняя полная форма",
        ),
    run: async (context, input) => {
      const command = ["plan", "list"];
      const filters = filtersOf(input.options);
      const query = offsetQuery(context, input.options, command, filters);
      const data =
        filters.projection === "compact"
          ? await context.backend.plans.listCompact(
              parse(plansCompactQuerySchema, { ...filters, ...query }, "компактный каталог планов"),
            )
          : await context.backend.plans.list(
              parse(plansQuerySchema, { ...filters, ...query }, "каталог планов"),
            );
      return {
        data,
        page: pageResult(context, command, filters, query, data),
        text: (options) =>
          planListText(
            "Планы работ",
            data.items.map((item) => ({
              key: item.key,
              title: item.title,
              fields: [
                ["Состояние", planningStatusLabels[item.status]],
                ...planCountFields(item.counts),
              ],
            })),
            filters,
            options,
            data.items[0]
              ? [
                  {
                    label: "Прочитать план — пример для первого ключа; подставьте выбранный ключ",
                    command: commandInvocation(context, ["plan", "get", data.items[0].key]),
                  },
                ]
              : [],
          ),
      };
    },
  });
  registerPlanCommand(plan, runtime, {
    name: "get <reference>",
    description: "Полные тексты и актуальное состояние",
    arguments: refArgument,
    details:
      "Полное содержание отображается как Markdown. Этапы страницами — plan stage list <reference>; задачи этапа — plan stage task list <reference> <stage>; готовность и причины — plan progress <reference>. Связи и материалы — inspect graph list --root <reference>. Сохранённое завершение не равно текущей готовности состава.",
    examples: [["npx @oim-dev/relay-cli plan get PLN-1", "Прочитать запись"]],
    run: async (context, input) => {
      const data = await context.backend.plans.get(input.argument());
      const commands = [
        {
          label: "Этапы",
          command: commandInvocation(context, ["plan", "stage", "list", data.key]),
        },
        { label: "Прогресс", command: commandInvocation(context, ["plan", "progress", data.key]) },
        {
          label: "Связи и прикреплённые материалы",
          command: commandInvocation(context, ["inspect", "graph", "list", "--root", data.key]),
        },
      ];
      return { data, text: (options) => planCardText(data, options, commands) };
    },
  });
  for (const action of ["create", "update"] as const)
    registerPlanCommand<Options>(plan, runtime, {
      name: action === "create" ? "create" : "update <reference>",
      description: action === "create" ? "Создать черновик плана" : "Изменить заданные поля плана",
      details:
        (action === "create"
          ? "Создаёт draft. Заполните цель (--goal или --goal-file), затем добавьте этапы и задачи через plan stage."
          : "Меняются только переданные поля; --scope и --participants заменяют соответствующие наборы целиком. Закрытый план неизменяем. Статус меняется только через start/complete/cancel.") +
        ` ${details}`,
      ...(action === "update" ? { arguments: refArgument } : {}),
      examples: [
        [
          `npx @oim-dev/relay-cli plan ${action}${action === "update" ? " PLN-1 --if-revision 1" : ""} --actor human --title "Первый результат" --goal "Проверенный сценарий"`,
          "Сохранить план",
        ],
      ],
      configure: (command) =>
        contentOptions(
          action === "create"
            ? writing(command).requiredOption("--title <title>", "Однострочное название")
            : revision(command).option("--title <title>", "Новое название"),
        ),
      run: async (context, input) => {
        const fields = await planFields(context, input.options);
        const authorId = author(context);
        const requestId = input.options.requestId ?? randomUUID();
        const data =
          action === "create"
            ? await context.backend.plans.create(
                parse(createPlanSchema, { ...fields, requestId }, "создание плана"),
                authorId,
              )
            : await context.backend.plans.update(
                input.argument(),
                parse(
                  updatePlanSchema,
                  { ...fields, ...metadata(input.options) },
                  "изменение плана",
                ),
                authorId,
              );
        return {
          data,
          text: (options) =>
            planningSavedText(data, options, [
              {
                label: "Прочитать план",
                command: commandInvocation(context, ["plan", "get", data.key]),
              },
            ]),
        };
      },
    });
  for (const action of ["start", "complete", "cancel"] as const)
    registerPlanCommand<Options>(plan, runtime, {
      name: `${action} <reference>`,
      description: {
        start: "Начать план",
        complete: "Завершить план с итогом",
        cancel: "Отменить план с причиной",
      }[action],
      details:
        {
          start:
            "Переводит draft в active. Нужны заполненная цель и непустой состав задач; условия проверьте через plan progress. start не обязателен для работы над задачами или последующего complete. --result для start необязателен.",
          complete:
            "Завершает draft/active. Обязателен непустой итог: --result или --result-file. Core проверяет непустой состав и выполнение всех задач; причины — plan progress. Закрытый план неизменяем.",
          cancel:
            "Отменяет открытый план. Обязательна непустая причина: --result или --result-file. Задачи не отменяются автоматически; закрытый план неизменяем.",
        }[action] + ` ${details}`,
      arguments: refArgument,
      examples: [
        [
          `npx @oim-dev/relay-cli plan ${action} PLN-1 --actor human --if-revision 3${action === "start" ? "" : ' --result "Итог работы"'}`,
          "Выполнить явный переход",
        ],
      ],
      configure: (command) =>
        textOption(
          revision(command),
          "result",
          "Итог или причина отмены в Markdown: фактический результат, основания проверок, ограничения и следующий шаг",
        ),
      run: async (context, input) => {
        const texts = await readTextFields(context, input.options, ["result"]);
        const data = await context.backend.plans.transition(
          input.argument(),
          parse(
            transitionPlanSchema,
            { ...texts, ...metadata(input.options), action },
            "переход плана",
          ),
          author(context),
        );
        return {
          data,
          text: (options) =>
            planningSavedText(data, options, [
              {
                label: "Прочитать план",
                command: commandInvocation(context, ["plan", "get", data.key]),
              },
            ]),
        };
      },
    });
  registerPlanCommand<Options>(stage, runtime, {
    name: "list <reference>",
    description: "Этапы плана с полным прогрессом",
    details: "Порядок этапов не определяет запрет исполнения.",
    arguments: refArgument,
    examples: [["npx @oim-dev/relay-cli plan stage list PLN-1", "Прочитать этапы"]],
    configure: paging,
    run: async (context, input) => {
      const command = ["plan", "stage", "list", input.argument()];
      const query = offsetQuery(context, input.options, command, {});
      const data = await context.backend.plans.stages(
        input.argument(),
        parse(planningPageQuerySchema, query, "страница этапов"),
      );
      return {
        data,
        page: pageResult(context, command, {}, query, data),
        text: (options) =>
          planListText(
            `Этапы · ${input.argument()}`,
            data.items.map((item) => ({
              key: item.id,
              title: item.title,
              fields: planCountFields(item.counts),
            })),
            {},
            options,
            data.items[0]
              ? [
                  {
                    label: "Прочитать этап — пример первого ID; замените ID, сохранив адрес плана",
                    command: commandInvocation(context, [
                      "plan",
                      "stage",
                      "get",
                      input.argument(),
                      data.items[0].id,
                    ]),
                  },
                ]
              : [],
          ),
      };
    },
  });
  registerPlanCommand<Options>(stageTask, runtime, {
    name: "list <reference> <stage>",
    description: "Актуальные задачи этапа",
    details: "Состав не включает подзадачи и зависимости автоматически.",
    arguments: { ...refArgument, stage: "Внутренний ID этапа плана" },
    examples: [
      [
        "npx @oim-dev/relay-cli plan stage task list PLN-1 Ab12Cd34",
        "Прочитать задачи этапа по его ID",
      ],
    ],
    configure: paging,
    run: async (context, input) => {
      const command = ["plan", "stage", "task", "list", input.argument(), input.argument(1)];
      const query = offsetQuery(context, input.options, command, {});
      const data = await context.backend.plans.tasks(
        input.argument(),
        input.argument(1),
        parse(planningPageQuerySchema, query, "страница задач"),
      );
      return {
        data,
        page: pageResult(context, command, {}, query, data),
        text: (options) =>
          planListText(
            `Задачи этапа · ${input.argument()} / ${input.argument(1)}`,
            data.items.map((item) => ({
              key: item.key,
              title: item.title,
              fields: [
                ["Колонка", planningColumnLabel(item.column)],
                ["Выполнена", item.completed ? "Да" : "Нет"],
                ["Заблокирована", item.blocked ? "Да" : "Нет"],
                ["Готова к работе", item.ready ? "Да" : "Нет"],
              ],
            })),
            {},
            options,
            [
              ...(data.items[0]
                ? [
                    {
                      label: "Прочитать задачу — пример первого ключа; подставьте выбранный ключ",
                      command: commandInvocation(context, ["task", "get", data.items[0].key]),
                    },
                    {
                      label: "Прогресс и блокеры — пример первого ключа",
                      command: commandInvocation(context, ["task", "progress", data.items[0].key]),
                    },
                  ]
                : []),
              {
                label: "Найти кандидатов для этого этапа",
                command: commandInvocation(context, [
                  "plan",
                  "task",
                  "candidates",
                  "--plan",
                  input.argument(),
                  "--stage",
                  input.argument(1),
                ]),
              },
            ],
          ),
      };
    },
  });
  registerPlanCommand<Options>(planTask, runtime, {
    name: "memberships <reference>",
    description: "Текущее участие задачи и включения в закрытые планы",
    details:
      "Читает включения из актуального состава планов, включая закрытые. Это не журнал перемещений или история изменений задачи.",
    arguments: { reference: "Ключ или ID задачи" },
    examples: [
      ["npx @oim-dev/relay-cli plan task memberships PRODUCT-1", "Прочитать участие задачи"],
    ],
    configure: paging,
    run: async (context, input) => {
      const command = ["plan", "task", "memberships", input.argument()];
      const query = offsetQuery(context, input.options, command, {});
      const data = await context.backend.plans.memberships(
        input.argument(),
        parse(planningPageQuerySchema, query, "участие задачи"),
      );
      return {
        data,
        page: pageResult(context, command, {}, query, data),
        text: (options) =>
          planListText(
            `Участие задачи · ${input.argument()}`,
            data.items.map((item) => ({
              key: item.planKey,
              title: item.planTitle,
              fields: [
                ["Состояние плана", planningStatusLabels[item.status]],
                ["Этап", item.stageTitle],
                ["ID этапа", item.stageId, "opaque"],
                ["Участие", item.current ? "Текущее" : "Закрытый план"],
              ],
            })),
            {},
            options,
            data.items[0]
              ? [
                  {
                    label: "Прочитать план — пример первой строки; подставьте выбранный ключ",
                    command: commandInvocation(context, ["plan", "get", data.items[0].planKey]),
                  },
                  {
                    label: "Прочитать этап — используйте план и ID из одной строки",
                    command: commandInvocation(context, [
                      "plan",
                      "stage",
                      "get",
                      data.items[0].planKey,
                      data.items[0].stageId,
                    ]),
                  },
                ]
              : [],
          ),
      };
    },
  });
  registerPlanCommand(stage, runtime, {
    name: "get <reference> <stage>",
    description: "Полное содержание этапа и явные ID задач",
    arguments: { ...refArgument, stage: "Внутренний ID этапа" },
    details:
      "Этап читается из полной сущности плана; ревизия принадлежит плану. Карточка содержит полные тексты и число задач. Актуальный состав страницами — plan stage task list <reference> <stage>; общий прогресс — plan progress <reference>.",
    examples: [["npx @oim-dev/relay-cli plan stage get PLN-1 Ab12Cd34", "Прочитать этап"]],
    run: async (context, input) => {
      const entity = await context.backend.entities.get({
        ref: input.argument(),
        kind: "work-plan",
      });
      const planData = parse(workPlanDataSchema, entity.data, "полное содержание плана");
      const selected = planData.stages.find((item) => item.id === input.argument(1));
      if (!selected)
        throw new AppError(
          "NOT_FOUND",
          "Этап не найден в выбранном плане; прочитайте plan stage list",
          4,
        );
      const data = {
        ...selected,
        planId: entity.ref.id,
        planKey: entity.key,
        planRevision: entity.revision,
      };
      const commands = {
        tasks: commandInvocation(context, [
          "plan",
          "stage",
          "task",
          "list",
          data.planKey ?? data.planId,
          data.id,
        ]),
      };
      return { data, text: (options) => stageText(data, options, commands) };
    },
  });
  for (const action of ["create", "update", "remove", "move"] as const)
    registerPlanCommand<Options>(stage, runtime, {
      name: `${action} <reference>${action === "create" ? "" : " <stage>"}`,
      description: {
        create: "Создать этап",
        update: "Изменить только переданные поля этапа",
        remove: "Удалить пустой этап",
        move: "Изменить порядок этапа",
      }[action],
      details:
        {
          create:
            "Создаёт этап; его ID вернётся в квитанции и plan stage list. Задачи включаются отдельно через plan stage task add.",
          update:
            "Укажите хотя бы одно поле. Неуказанные поля сохраняются; пустая строка очищает краткое описание, результат или условия завершения.",
          remove:
            "Удаляет только пустой этап. Сначала явно исключите его задачи через plan stage task remove; сами задачи сохраняются.",
          move: "Перемещает этап перед --before <ID этапа> или в конец без этого флага. Порядок этапов не создаёт зависимостей и не сортирует задачи внутри этапа.",
        }[action] + ` ID этапов возьмите из plan stage list. ${details}`,
      arguments: {
        ...refArgument,
        ...(action === "create" ? {} : { stage: "Внутренний ID этапа плана" }),
      },
      examples: [
        [
          `npx @oim-dev/relay-cli plan stage ${action} PLN-1${action === "create" ? ' --title "Первый этап"' : ` Ab12Cd34${action === "update" ? ' --outcome "Проверенный результат"' : ""}`} --actor human --if-revision 2`,
          "Изменить этап",
        ],
      ],
      configure: (command) => {
        revision(command);
        if (action === "create") command.requiredOption("--title <title>", "Название этапа");
        if (action === "update") command.option("--title <title>", "Новое название этапа");
        if (action === "create" || action === "update")
          for (const [name, label] of [
            ["summary", "Краткое описание"],
            [
              "outcome",
              "Результат этапа в Markdown: что должно получиться и границы ответственности",
            ],
            [
              "completion-conditions",
              "Условия завершения в Markdown: наблюдаемые признаки и способ проверки; не исполняемый код",
            ],
          ])
            textOption(command, name!, label!);
        if (action === "move")
          command.option("--before <id>", "ID следующего этапа; без параметра — конец списка");
      },
      run: async (context, input) => {
        const fields = Object.fromEntries(
          Object.keys(stageFieldsSchema.shape)
            .filter((key) => input.options[key] !== undefined)
            .map((key) => [key, input.options[key]]),
        );
        Object.assign(
          fields,
          await readTextFields(context, input.options, [
            "summary",
            "outcome",
            "completionConditions",
          ]),
        );
        const data = await context.backend.plans.changeStage(
          input.argument(),
          parse(
            changeStageSchema,
            {
              ...metadata(input.options),
              action,
              ...(action === "create" || action === "update" ? { fields } : {}),
              ...(action === "create" ? {} : { stage: input.argument(1) }),
              ...(action === "move" ? { before: input.options.before ?? null } : {}),
            },
            "изменение этапа",
          ),
          author(context),
        );
        return {
          data,
          text: (options) =>
            planningSavedText(data, options, [
              {
                label: action === "remove" ? "Этапы" : "Прочитать этап",
                command: commandInvocation(
                  context,
                  action === "remove"
                    ? ["plan", "stage", "list", data.key]
                    : ["plan", "stage", "get", data.key, data.stageId ?? input.argument(1)],
                ),
              },
            ]),
        };
      },
    });
  for (const action of ["add", "remove"] as const)
    registerPlanCommand<Options>(stageTask, runtime, {
      name: `${action} <reference> <stage>`,
      description: action === "add" ? "Включить задачи в этап" : "Исключить задачи из этапа",
      details:
        (action === "add"
          ? "Включает существующие задачи, не копии. Кандидаты и текущее участие — plan task candidates; ID этапа — plan stage list. Дети и зависимости автоматически не включаются."
          : "Снимает только перечисленные включения, сохраняя сами задачи. Текущий состав — plan stage task list.") +
        ` ${details}`,
      arguments: { ...refArgument, stage: "Внутренний ID этапа плана" },
      examples: [
        [
          `npx @oim-dev/relay-cli plan stage task ${action} PLN-1 Ab12Cd34 --actor human --tasks PRODUCT-1 --if-revision 2`,
          "Изменить состав",
        ],
      ],
      configure: (command) =>
        revision(command).requiredOption(
          "--tasks <references...>",
          "Ключи или ID задач, максимум 2000",
        ),
      run: async (context, input) => {
        const data = await context.backend.plans.changeTasks(
          input.argument(),
          parse(
            changePlanTasksSchema,
            {
              ...metadata(input.options),
              stage: input.argument(1),
              [action]: input.options.tasks,
            },
            "состав этапа",
          ),
          author(context),
        );
        return {
          data,
          text: (options) =>
            planningSavedText(
              data,
              options,
              [
                {
                  label: "Состав этапа",
                  command: commandInvocation(context, [
                    "plan",
                    "stage",
                    "task",
                    "list",
                    data.key,
                    input.argument(1),
                  ]),
                },
              ],
              {
                action: action === "add" ? "Задачи включены в этап" : "Задачи исключены из этапа",
                stageId: input.argument(1),
              },
            ),
        };
      },
    });
  registerPlanCommand<Options>(stageTask, runtime, {
    name: "transfer <reference> <task> <targetStage>",
    description: "Явно перенести задачу между этапами или планами",
    details: `Аргументы по порядку: исходный план, задача, ID целевого этапа. Нужны --target-plan, исходная ревизия первого плана (--if-revision), ревизия целевого (--target-revision) и непустая причина (--reason либо --reason-file). Для переноса внутри плана укажите его же как целевой и одинаковые ревизии. ID этапов — plan stage list; участие задачи — plan task memberships. ${details}`,
    arguments: {
      reference: "Ключ или ID исходного плана; его ревизия — --if-revision",
      task: "Ключ или ID задачи",
      targetStage: "Внутренний ID целевого этапа",
    },
    examples: [
      [
        "npx @oim-dev/relay-cli plan stage task transfer PLN-1 PRODUCT-1 Ef56Gh78 --actor human --target-plan PLN-2 --if-revision 3 --target-revision 2 --reason 'Пересмотр состава'",
        "Перенести задачу",
      ],
    ],
    configure: (command) =>
      textOption(
        revision(command)
          .requiredOption("--target-plan <reference>", "Ключ или ID целевого плана")
          .requiredOption(
            "--target-revision <n>",
            "Ревизия целевого плана",
            integer(1, Number.MAX_SAFE_INTEGER),
          ),
        "reason",
        "Причина переноса в Markdown",
      ),
    run: async (context, input) => {
      const texts = await readTextFields(context, input.options, ["reason"]);
      const data = await context.backend.plans.transfer(
        input.argument(),
        parse(
          transferPlanTaskSchema,
          {
            targetPlan: input.options.targetPlan,
            targetRevision: input.options.targetRevision,
            ...texts,
            ...metadata(input.options),
            task: input.argument(1),
            targetStage: input.argument(2),
          },
          "перенос",
        ),
        author(context),
      );
      return {
        data,
        text: (options) =>
          planningSavedText(
            data,
            options,
            [
              {
                label: "Исходный план",
                command: commandInvocation(context, ["plan", "get", data.key]),
              },
              {
                label: "Целевой состав",
                command: commandInvocation(context, [
                  "plan",
                  "stage",
                  "task",
                  "list",
                  String(input.options.targetPlan),
                  input.argument(2),
                ]),
              },
            ],
            {
              task: input.argument(1),
              targetPlan: String(input.options.targetPlan),
              stageId: input.argument(2),
            },
          ),
      };
    },
  });
}
