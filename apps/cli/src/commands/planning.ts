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
import {
  planningListText,
  planningSavedText,
  planningStatusLabels,
  planText,
  releaseText,
  planningColumnLabel,
} from "../presentation/planning.js";

type Options = Record<string, unknown>;
const details =
  "Запись выполняется с автором и прочитанной ревизией. request-id служит только корреляции, результат не сохраняется для повтора. После потери ответа перечитайте состояние; повтор может выполнить новое действие. Старый формат планов и релизов не поддерживается; автоматического переноса нет.";
const refArgument = { reference: "Ключ или постоянный ID выбранной сущности" };
const paging = (command: Command) =>
  command
    .option("--offset <n>", "Смещение страницы", integer(0, Number.MAX_SAFE_INTEGER))
    .option("--limit <n>", "Размер страницы, максимум 100", integer(1, 100))
    .option("--snapshot-version <version>", "Версия первой страницы; обязательна при продолжении");
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
const pageInput = (options: Options) => {
  const { snapshotVersion, ...query } = options;
  return { ...query, ...(snapshotVersion === undefined ? {} : { version: snapshotVersion }) };
};
const metadata = (options: Options) => ({
  requestId: options.requestId ?? randomUUID(),
  ifRevision: options.ifRevision,
});

async function planFields(context: CommandContext, options: Options) {
  const fields = Object.fromEntries(
    Object.keys(workPlanFieldsSchema.shape)
      .filter((key) => options[key] !== undefined && key !== "scope")
      .map((key) => [key, options[key]]),
  );
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
const contentOptions = (command: Command) =>
  command
    .option("--summary <text>", "Краткое описание обычным текстом")
    .option("--goal <markdown>", "Цель в Markdown")
    .option("--rationale <markdown>", "Обоснование начала в Markdown")
    .option("--boundaries <markdown>", "Границы изменения в Markdown")
    .option("--expected-result <markdown>", "Ожидаемый результат в Markdown")
    .option("--scope <references...>", "Области воздействия: ключи или kind:ID")
    .option("--clear-scope", "Явно очистить область изменения")
    .option("--participants <actors...>", "Участники плана");

/** Предметные команды планирования; форматирование отделено от Core. */
export function registerPlanning(program: Command, runtime: Runtime): void {
  const plan = commandGroup(program, {
    name: "plan",
    description: "Планы работ, этапы и состав задач",
    details,
    examples: [["relay-cli plan list", "Прочитать планы проекта"]],
  });
  const release = commandGroup(program, {
    name: "release",
    description: "Самостоятельные релизы, актуальный состав и готовность",
    details,
    examples: [["relay-cli release list", "Прочитать релизы проекта"]],
  });
  registerCommand<Options>(plan, runtime, {
    name: "candidates",
    description: "Найти задачи для включения в этап",
    details:
      "Доступность, доска и поиск применяются до пагинации. Состав выбранного этапа остаётся видимым.",
    examples: [["relay-cli plan candidates --available-only true", "Прочитать свободные задачи"]],
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
      const data = await context.backend.plans.candidates(
        parse(planningCandidatesQuerySchema, pageInput(input.options), "выбор задач"),
      );
      return {
        data,
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
            "plan candidates",
            input.options,
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
      examples: [[`relay-cli ${kind} list --limit 12`, "Прочитать первую страницу"]],
      configure: (command) =>
        paging(command)
          .option("--q <text>", "Поиск по ключу, названию и описанию")
          .option("--status <status>", "Предметное состояние плана или релиза"),
      run: async (context, input) => {
        if (kind === "plan") {
          const data = await context.backend.plans.list(
            parse(plansQuerySchema, pageInput(input.options), "каталог планов"),
          );
          return {
            data,
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
                input.options,
                options,
                context.globals,
              ),
          };
        }
        const data = await context.backend.releases.list(
          parse(releasesQuerySchema, pageInput(input.options), "каталог релизов"),
        );
        return {
          data,
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
              input.options,
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
        [`relay-cli ${kind} get ${kind === "plan" ? "PLN" : "REL"}-1`, "Прочитать запись"],
      ],
      run: async (context, input) => {
        if (kind === "plan") {
          const data = await context.backend.plans.get(input.argument());
          return { data, text: (options) => planText(data, options) };
        }
        const data = await context.backend.releases.get(input.argument());
        return { data, text: (options) => releaseText(data, options) };
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
          `relay-cli --actor human plan ${action}${action === "update" ? " PLN-1 --if-revision 1" : ""} --title "Первый результат" --goal "Проверенный сценарий"`,
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
        return { data, text: () => planningSavedText(data) };
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
          `relay-cli --actor human plan ${action} PLN-1 --if-revision 3${action === "start" ? "" : ' --result "Итог работы"'}`,
          "Выполнить явный переход",
        ],
      ],
      configure: (command) =>
        revision(command).option(
          "--result <markdown>",
          "Итог завершения или причина отмены в Markdown",
        ),
      run: async (context, input) => {
        const data = await context.backend.plans.transition(
          input.argument(),
          parse(
            transitionPlanSchema,
            { ...input.options, ...metadata(input.options), action },
            "переход плана",
          ),
          author(context),
        );
        return { data, text: () => planningSavedText(data) };
      },
    });
  registerCommand<Options>(plan, runtime, {
    name: "stages <reference>",
    description: "Этапы плана с полным прогрессом",
    details: "Порядок этапов не определяет запрет исполнения.",
    arguments: refArgument,
    examples: [["relay-cli plan stages PLN-1", "Прочитать этапы"]],
    configure: paging,
    run: async (context, input) => {
      const data = await context.backend.plans.stages(
        input.argument(),
        parse(planningPageQuerySchema, pageInput(input.options), "страница этапов"),
      );
      return {
        data,
        text: (options) =>
          planningListText(
            "Этапы",
            ["ID этапа", "Название", "Задачи"],
            data.items.map((item) => [
              item.id,
              item.title,
              `${item.counts.completed}/${item.counts.total}`,
            ]),
            data,
            `plan stages ${input.argument()}`,
            input.options,
            options,
            context.globals,
          ),
      };
    },
  });
  registerCommand<Options>(plan, runtime, {
    name: "tasks <reference> <stage>",
    description: "Актуальные задачи этапа",
    details: "Состав не включает подзадачи и зависимости автоматически.",
    arguments: { ...refArgument, stage: "Внутренний ID этапа плана" },
    examples: [["relay-cli plan tasks PLN-1 Ab12Cd34", "Прочитать задачи этапа по его ID"]],
    configure: paging,
    run: async (context, input) => {
      const data = await context.backend.plans.tasks(
        input.argument(),
        input.argument(1),
        parse(planningPageQuerySchema, pageInput(input.options), "страница задач"),
      );
      return {
        data,
        text: (options) =>
          planningListText(
            "Задачи этапа",
            ["Ключ", "Название", "Колонка", "Выполнена"],
            data.items.map((item) => [
              item.key,
              item.title,
              planningColumnLabel(item.column),
              item.completed ? "Да" : "Нет",
            ]),
            data,
            `plan tasks ${input.argument()} ${input.argument(1)}`,
            input.options,
            options,
            context.globals,
          ),
      };
    },
  });
  registerCommand<Options>(plan, runtime, {
    name: "memberships <reference>",
    description: "Текущее участие задачи и включения в закрытые планы",
    details:
      "Читает включения из актуального состава планов, включая закрытые. Это не журнал перемещений или история изменений задачи.",
    arguments: { reference: "Ключ или ID задачи" },
    examples: [["relay-cli plan memberships PRODUCT-1", "Прочитать участие задачи"]],
    configure: paging,
    run: async (context, input) => {
      const data = await context.backend.plans.memberships(
        input.argument(),
        parse(planningPageQuerySchema, pageInput(input.options), "участие задачи"),
      );
      return {
        data,
        text: (options) =>
          planningListText(
            "Участие задачи",
            ["План", "Этап", "Участие"],
            data.items.map((item) => [
              item.planKey,
              item.stageTitle,
              item.current ? "Текущее" : "Историческое",
            ]),
            data,
            `plan memberships ${input.argument()}`,
            input.options,
            options,
            context.globals,
          ),
      };
    },
  });
  const stage = commandGroup(plan, {
    name: "stage",
    description: "Создание, содержание и порядок этапов",
    details,
    examples: [["relay-cli plan stages PLN-1", "Прочитать состав перед изменением"]],
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
          `relay-cli --actor human plan stage ${action} PLN-1${action === "create" ? ' --title "Первый этап"' : ` Ab12Cd34${action === "update" ? ' --outcome "Проверенный результат"' : ""}`} --if-revision 2`,
          "Изменить этап",
        ],
      ],
      configure: (command) => {
        revision(command);
        if (action === "create") command.requiredOption("--title <title>", "Название этапа");
        if (action === "update") command.option("--title <title>", "Новое название этапа");
        if (action === "create" || action === "update")
          command
            .option("--summary <text>", "Краткое описание")
            .option("--outcome <markdown>", "Результат этапа в Markdown")
            .option("--completion-conditions <markdown>", "Условия завершения в Markdown");
        if (action === "move")
          command.option("--before <id>", "ID следующего этапа; без параметра — конец списка");
      },
      run: async (context, input) => {
        const fields = Object.fromEntries(
          Object.keys(stageFieldsSchema.shape)
            .filter((key) => input.options[key] !== undefined)
            .map((key) => [key, input.options[key]]),
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
        return { data, text: () => planningSavedText(data) };
      },
    });
  for (const action of ["include", "exclude"] as const)
    registerCommand<Options>(plan, runtime, {
      name: `${action} <reference> <stage>`,
      description: action === "include" ? "Включить задачи в этап" : "Исключить задачи из этапа",
      details,
      arguments: { ...refArgument, stage: "Внутренний ID этапа плана" },
      examples: [
        [
          `relay-cli --actor human plan ${action} PLN-1 Ab12Cd34 --tasks PRODUCT-1 --if-revision 2`,
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
              [action === "include" ? "add" : "remove"]: input.options.tasks,
            },
            "состав этапа",
          ),
          author(context),
        );
        return { data, text: () => planningSavedText(data) };
      },
    });
  registerCommand<Options>(plan, runtime, {
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
        "relay-cli --actor human plan transfer PLN-1 PRODUCT-1 Ef56Gh78 --target-plan PLN-2 --if-revision 3 --target-revision 2 --reason 'Пересмотр состава'",
        "Перенести задачу",
      ],
    ],
    configure: (command) =>
      revision(command)
        .requiredOption("--target-plan <reference>", "Ключ или ID целевого плана")
        .requiredOption(
          "--target-revision <n>",
          "Ревизия целевого плана",
          integer(1, Number.MAX_SAFE_INTEGER),
        )
        .requiredOption("--reason <markdown>", "Причина переноса в Markdown"),
    run: async (context, input) => {
      const data = await context.backend.plans.transfer(
        input.argument(),
        parse(
          transferPlanTaskSchema,
          {
            ...input.options,
            ...metadata(input.options),
            task: input.argument(1),
            targetStage: input.argument(2),
          },
          "перенос",
        ),
        author(context),
      );
      return { data, text: () => planningSavedText(data) };
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
      ["relay-cli release preview --plans PLN-1 PLN-2", "Узнать готовность будущего состава"],
    ],
    configure: (command) =>
      paging(command).option(
        "--plans <references...>",
        "Ключи или ID выбранных планов, максимум 200",
      ),
    run: async (context, input) => {
      const data = await context.backend.releases.preview(
        parse(
          releasePreviewSchema,
          { ...pageInput(input.options), plans: input.options.plans ?? [] },
          "предпросмотр релиза",
        ),
      );
      return {
        data,
        text: (options) =>
          planningListText(
            `Текущая готовность: ${data.readiness.ready}/${data.readiness.total} планов`,
            ["Ключ", "Название", "Состояние", "Задачи сейчас"],
            data.items.map(({ id, plan }) => [
              plan?.key ?? id,
              plan?.title ?? "План недоступен",
              plan ? planningStatusLabels[plan.status]! : "Недоступен",
              plan ? `${plan.counts.completed}/${plan.counts.total}` : "—",
            ]),
            data,
            "release preview",
            input.options,
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
          `relay-cli --actor human release ${action}${action === "update" ? " REL-1 --if-revision 1" : ""} --title "Первый выпуск" --release-version 0.1 --plans PLN-1`,
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
        command
          .option("--summary <text>", "Краткое описание")
          .option("--description <markdown>", "Полное описание в Markdown")
          .option("--planned-for <date>", "Плановая дата YYYY-MM-DD; пустая строка очищает дату")
          .option(
            "--status <status>",
            "planned, cancelled или released; released фиксирует выпуск",
          );
      },
      run: async (context, input) => {
        const previous =
          action === "update" ? await context.backend.releases.get(input.argument()) : undefined;
        const options = input.options;
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
        return { data, text: () => planningSavedText(data) };
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
          `relay-cli --actor human release ${action} REL-1 --if-revision 1`,
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
        return { data, text: () => planningSavedText(data) };
      },
    });
  registerCommand<Options>(group, runtime, {
    name: "plans <reference>",
    description: "Актуальные планы выбранного состава",
    details:
      "Страницы имеют версию и явное продолжение. Готовность отражает текущие задачи даже после выпуска.",
    arguments: refArgument,
    examples: [["relay-cli release plans REL-1 --limit 12", "Прочитать страницу"]],
    configure: paging,
    run: async (context, input) => {
      const query = parse(planningPageQuerySchema, pageInput(input.options), "страница релиза");
      const data = await context.backend.releases.composition(input.argument(), query);
      return {
        data,
        text: (options) =>
          planningListText(
            `Планы релиза · текущая готовность: ${data.readiness.ready}/${data.readiness.total}`,
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
