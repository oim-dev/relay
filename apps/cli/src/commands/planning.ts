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
  planningPageQuerySchema,
  workPlanFieldsSchema,
  stageFieldsSchema,
  planningCandidatesQuerySchema,
  workPlanDataSchema,
} from "@relay/contracts/planning";
import {
  saveReleaseSchema,
  updateReleaseSchema,
  releasesQuerySchema,
  releaseActionSchema,
  releasePreviewSchema,
} from "@relay/contracts/releases";
import { parse } from "@relay/core/domain/validation";
import { commandGroup, registerCommand } from "../command.js";
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
  planningListText,
  planningSavedText,
  planningStatusLabels,
  planText,
  releaseText,
  planningColumnLabel,
  stageText,
} from "../presentation/planning.js";

type Options = Record<string, unknown>;
const details =
  "Запись выполняется с автором и прочитанной ревизией. request-id служит только корреляции, результат не сохраняется для повтора. После потери ответа перечитайте состояние; повтор может выполнить новое действие. Старый формат планов и релизов не поддерживается; автоматического переноса нет.";
const refArgument = { reference: "Ключ или постоянный ID выбранной сущности" };
const writing = (command: Command) =>
  command.option(
    "--request-id <id>",
    "Идентификатор корреляции, не дедупликации; по умолчанию UUID",
  );
const revision = (command: Command) =>
  writing(command).requiredOption(
    "--if-revision <n>",
    "Прочитанная ревизия плана или релиза",
    integer(1, Number.MAX_SAFE_INTEGER),
  );
const filtersOf = ({ limit, cursor, ...filters }: Options) => filters;
const metadata = (options: Options) => ({
  requestId: options.requestId ?? randomUUID(),
  ifRevision: options.ifRevision,
});

async function planFields(context: CommandContext, options: Options) {
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
    .option("--participants <actors...>", "Участники плана");
};

/** Предметные команды планирования; форматирование отделено от Core. */
export function registerPlanning(program: Command, runtime: Runtime): void {
  const plan = commandGroup(program, {
    name: "plan",
    description: "Планы работ, этапы и состав задач",
    details,
    examples: [["npx @oim-dev/relay-cli plan list", "Прочитать планы проекта"]],
  });
  const release = commandGroup(program, {
    name: "release",
    description: "Самостоятельные релизы, актуальный состав и готовность",
    details,
    examples: [["npx @oim-dev/relay-cli release list", "Прочитать релизы проекта"]],
  });
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
  registerEntityProgress(release, runtime, "release");
  registerCommand<Options>(planTask, runtime, {
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
      const data = await context.backend.plans.candidates(
        parse(planningCandidatesQuerySchema, { ...filters, ...query }, "выбор задач"),
      );
      return {
        data,
        page: pageResult(context, command, filters, query, data),
        text: (options) =>
          planningListText(
            "Задачи для плана",
            ["Ключ", "Название", "Колонка", "Участие"],
            data.items.map((item) => [
              item.key,
              item.title,
              planningColumnLabel(item.column),
              item.assignment?.planKey ?? "Без текущего плана",
            ]),
            data,
            "plan task candidates",
            filters,
            options,
            context.globals,
          ),
      };
    },
  });
  for (const [kind, group] of [
    ["plan", plan],
    ["release", release],
  ] as const) {
    registerCommand<Options>(group, runtime, {
      name: "list",
      description:
        kind === "plan" ? "Каталог планов с прогрессом" : "Каталог релизов с готовностью",
      details: "Полные итоги независимы от страницы; продолжение сохраняет фильтры и версию.",
      examples: [[`npx @oim-dev/relay-cli ${kind} list --limit 12`, "Прочитать первую страницу"]],
      configure: (command) =>
        paging(command)
          .option("--q <text>", "Поиск по ключу, названию и описанию")
          .option("--status <status>", "Предметное состояние плана или релиза"),
      run: async (context, input) => {
        const command = [kind, "list"];
        const filters = filtersOf(input.options);
        const query = offsetQuery(context, input.options, command, filters);
        if (kind === "plan") {
          const data = await context.backend.plans.list(
            parse(plansQuerySchema, { ...filters, ...query }, "каталог планов"),
          );
          return {
            data,
            page: pageResult(context, command, filters, query, data),
            text: (options) =>
              planningListText(
                "Планы работ",
                ["Ключ", "Название", "Состояние", "Задачи"],
                data.items.map((item) => [
                  item.key,
                  item.title,
                  planningStatusLabels[item.status]!,
                  `${item.counts.completed}/${item.counts.total}`,
                ]),
                data,
                "plan list",
                filters,
                options,
                context.globals,
              ),
          };
        }
        const data = await context.backend.releases.list(
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
      examples: [
        [
          `npx @oim-dev/relay-cli ${kind} get ${kind === "plan" ? "PLN" : "REL"}-1`,
          "Прочитать запись",
        ],
      ],
      run: async (context, input) => {
        if (kind === "plan") {
          const data = await context.backend.plans.get(input.argument());
          const commands = {
            stages: commandInvocation(context, ["plan", "stage", "list", data.key]),
            progress: commandInvocation(context, ["plan", "progress", data.key]),
          };
          return { data, text: (options) => planText(data, options, commands) };
        }
        const data = await context.backend.releases.get(input.argument());
        const commands = {
          plans: commandInvocation(context, ["release", "plans", data.key]),
          progress: commandInvocation(context, ["release", "progress", data.key]),
        };
        return { data, text: (options) => releaseText(data, options, commands) };
      },
    });
  }
  for (const action of ["create", "update"] as const)
    registerCommand<Options>(plan, runtime, {
      name: action === "create" ? "create" : "update <reference>",
      description: action === "create" ? "Создать черновик плана" : "Изменить заданные поля плана",
      details,
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
    registerCommand<Options>(plan, runtime, {
      name: `${action} <reference>`,
      description: {
        start: "Начать план",
        complete: "Завершить план с итогом",
        cancel: "Отменить план с причиной",
      }[action],
      details,
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
  registerCommand<Options>(stage, runtime, {
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
          planningListText(
            `Этапы · ${input.argument()}`,
            ["ID этапа", "Название", "Задачи"],
            data.items.map((item) => [
              item.id,
              item.title,
              `${item.counts.completed}/${item.counts.total}`,
            ]),
            data,
            `plan stage list ${input.argument()}`,
            input.options,
            options,
            context.globals,
          ),
      };
    },
  });
  registerCommand<Options>(stageTask, runtime, {
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
          planningListText(
            `Задачи этапа · ${input.argument()} / ${input.argument(1)}`,
            ["Ключ", "Название", "Колонка", "Выполнена"],
            data.items.map((item) => [
              item.key,
              item.title,
              planningColumnLabel(item.column),
              item.completed ? "Да" : "Нет",
            ]),
            data,
            `plan stage task list ${input.argument()} ${input.argument(1)}`,
            input.options,
            options,
            context.globals,
          ),
      };
    },
  });
  registerCommand<Options>(planTask, runtime, {
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
          planningListText(
            `Участие задачи · ${input.argument()}`,
            ["План", "Этап", "ID этапа", "Участие"],
            data.items.map((item) => [
              item.planKey,
              item.stageTitle,
              item.stageId,
              item.current ? "Текущее" : "Закрытый план",
            ]),
            data,
            `plan task memberships ${input.argument()}`,
            input.options,
            options,
            context.globals,
          ),
      };
    },
  });
  registerCommand(stage, runtime, {
    name: "get <reference> <stage>",
    description: "Полное содержание этапа и явные ID задач",
    arguments: { ...refArgument, stage: "Внутренний ID этапа" },
    details: "Этап читается из полной сущности плана; ревизия принадлежит плану.",
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
    registerCommand<Options>(stage, runtime, {
      name: `${action} <reference>${action === "create" ? "" : " <stage>"}`,
      description: {
        create: "Создать этап",
        update: "Изменить только переданные поля этапа",
        remove: "Удалить пустой этап",
        move: "Изменить порядок этапа",
      }[action],
      details:
        action === "update"
          ? `${details} Укажите хотя бы одно поле. Неуказанные поля сохраняются; пустая строка очищает краткое описание, результат или условия завершения.`
          : details,
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
    registerCommand<Options>(stageTask, runtime, {
      name: `${action} <reference> <stage>`,
      description: action === "add" ? "Включить задачи в этап" : "Исключить задачи из этапа",
      details,
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
  registerCommand<Options>(stageTask, runtime, {
    name: "transfer <reference> <task> <targetStage>",
    description: "Явно перенести задачу между этапами или планами",
    details,
    arguments: {
      ...refArgument,
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
  registerReleases(release, runtime);
}

/** Релизные команды передают значимые параметры напрямую, без непрозрачного JSON-запроса. */
function registerReleases(group: Command, runtime: Runtime) {
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
      paging(command).option(
        "--plans <references...>",
        "Ключи или ID выбранных планов, максимум 200",
      ),
    run: async (context, input) => {
      const command = ["release", "preview"];
      const filters: Record<string, unknown> = {
        plans:
          input.options.plans === undefined
            ? undefined
            : z
                .array(z.string())
                .parse(input.options.plans)
                .flatMap((value) => value.split(",")),
      };
      const query = offsetQuery(context, input.options, command, filters);
      const data = await context.backend.releases.preview(
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
        const planIds =
          options.plans === undefined
            ? previous?.planIds
            : await Promise.all(
                z
                  .array(z.string())
                  .parse(options.plans)
                  .map(
                    async (ref) =>
                      (await context.backend.entities.resolve({ ref, kind: "work-plan" })).ref.id,
                  ),
              );
        const command = parse(
          saveReleaseSchema,
          {
            ...metadata(options),
            title: options.title ?? previous?.title,
            version: options.releaseVersion ?? previous?.version,
            summary: options.summary ?? previous?.summary,
            description: options.description ?? previous?.description,
            plannedFor: options.plannedFor ?? previous?.plannedFor,
            status: options.status ?? previous?.status,
            planIds,
          },
          "сохранение релиза",
        );
        const data =
          action === "create"
            ? await context.backend.releases.create(command, author(context))
            : await context.backend.releases.update(
                input.argument(),
                updateReleaseSchema.parse(command),
                author(context),
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
        const data = await context.backend.releases.transition(
          input.argument(),
          parse(
            releaseActionSchema,
            { ...metadata(input.options), action: action === "publish" ? "release" : action },
            "переход релиза",
          ),
          author(context),
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
    configure: paging,
    run: async (context, input) => {
      const command = ["release", "plans", input.argument()];
      const query = offsetQuery(context, input.options, command, {});
      const data = await context.backend.releases.composition(input.argument(), query);
      return {
        data,
        page: pageResult(context, command, {}, query, data),
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
            input.options,
            options,
            context.globals,
          ),
      };
    },
  });
}
