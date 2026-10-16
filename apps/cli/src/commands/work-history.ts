import { Command, InvalidArgumentError } from "commander";
import { z } from "zod";
import * as contract from "@relay/contracts/work-history";
import { parse } from "@relay/core/domain/validation";
import {
  commandGroup,
  registerCommand as registerBaseCommand,
  type CommandDefinition,
} from "../command.js";
import { AppError } from "@relay/core/shared/errors";
import { PresentedError } from "../output.js";
import { cardText } from "../presentation/common.js";
import { diagnosticValueText } from "../presentation/text.js";
import { unwrapServerDetails } from "../presentation/recovery.js";
import { author, type CommandContext, type Runtime } from "../context.js";
import { integer, recordOptions, requestId } from "../options.js";
import {
  commandInvocation,
  offsetQuery,
  pageResult,
  paging,
  readTextFields,
  textOption,
} from "../command-kit.js";
import {
  checkpointText,
  historyText,
  intentsText,
  sessionContextText,
  sessionListText,
  sessionText,
  sessionTreeText,
  workSavedText,
} from "../presentation/work-history.js";
import { workConnectionMetadata } from "./work-history-connection.js";

type Options = Record<string, unknown> & { limit?: number; cursor?: string; requestId?: string };
const details =
  "История работы — сохранённые ветки, участия и материалы, не журнал команд и не присутствие online. Автор: --actor или RELAY_ACTOR. Все изменения существующей ветки требуют её прочитанную --if-revision; --run принимает постоянный run.id, не ключ RUN-token. Ключи S-token/CP-token в примерах заменяйте адресами из ответа; новые ключи случайны, не порядковые номера. После потери ответа перечитайте состояние, не повторяйте запись вслепую.";
const sessionArgument = { reference: "Ветка: ключ S-token, постоянный ID или work-session:ID" };
const checkpointArgument = {
  reference: "Исходное открытое намерение: CP-token, постоянный ID или work-checkpoint:ID",
};
const invokeFor = (context: CommandContext) => (tokens: string[]) =>
  commandInvocation(context, tokens);

/** Предметные ошибки ведут к чтению или справке, никогда к повтору записи. */
function registerCommand<O extends object = Record<string, never>>(
  parent: Command,
  runtime: Runtime,
  definition: CommandDefinition<O>,
): void {
  registerBaseCommand<O>(parent, runtime, {
    ...definition,
    async run(context, input) {
      try {
        return await definition.run(context, input);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        const action = definition.name.split(" ")[0]!;
        const ref = input.optionalArgument();
        const invalidInput = ["INVALID_ARGUMENT", "CONFLICTING_OPTIONS", "ACTOR_REQUIRED"].includes(
          error.code,
        );
        const pageConflict =
          parent.name() === "session" &&
          ["list", "tree", "intents", "history", "context"].includes(action) &&
          ["INVALID_CURSOR", "VERSION_CONFLICT", "SNAPSHOT_CONFLICT"].includes(error.code);
        const checkpointRef =
          (parent.name() === "checkpoint" && action !== "open") ||
          (parent.name() === "session" && action === "fork");
        const missing = ["NOT_FOUND", "ENTITY_NOT_FOUND"].includes(error.code);
        const details = unwrapServerDetails(error.details);
        const sessionId =
          details &&
          typeof details === "object" &&
          "sessionId" in details &&
          typeof details.sessionId === "string"
            ? details.sessionId
            : undefined;
        const target = invalidInput
          ? [parent.name(), action, "--help"]
          : pageConflict
            ? [parent.name(), action, ...(ref ? [ref] : [])]
            : !ref || missing
              ? checkpointRef
                ? ["session", "history", "--kind", "checkpoint"]
                : ["session", "list"]
              : error.code === "REVISION_CONFLICT" && sessionId
                ? ["session", "get", `work-session:${sessionId}`]
                : [checkpointRef ? "checkpoint" : "session", "get", ref];
        throw new PresentedError(
          error.code,
          error.message,
          error.exitCode,
          error.details,
          (options) =>
            cardText(
              {
                title: error.message,
                sections: [
                  ...(error.details === undefined
                    ? []
                    : [{ title: "Подробности", body: diagnosticValueText(error.details) }]),
                  {
                    title: "Следующий шаг",
                    body: invalidInput
                      ? "Исправьте параметры и источники ввода по справке. Повтор записи не выполнялся."
                      : pageConflict
                        ? "Начните чтение без cursor с нужными фильтрами; не смешивайте страницы разных состояний."
                        : missing
                          ? "Проверьте выбранный проект и найдите существующий адрес в предложенной выборке. Не повторяйте чтение неизвестного адреса или запись вслепую."
                          : "Перечитайте состояние и проверьте адрес, намерения, детей и текущее участие. Не подставляйте свежую ревизию/run автоматически; после потери ответа запись могла сохраниться.",
                  },
                ],
                commands: [
                  {
                    purpose: "recovery",
                    label: invalidInput ? "Справка команды" : "Проверить сохранённое состояние",
                    command: commandInvocation(context, target),
                  },
                ],
              },
              options,
            ),
        );
      }
    },
  });
}
const boolean = (value: string) => {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new InvalidArgumentError("Ожидается true или false");
};
const branchOptions = (command: Command) =>
  recordOptions(command).requiredOption(
    "--if-revision <n>",
    "Прочитанная ревизия ВЕТКИ (у fork и checkpoint — родительской/владеющей ветки)",
    integer(1, Number.MAX_SAFE_INTEGER),
  );
const ownerOptions = (command: Command) =>
  branchOptions(command).requiredOption(
    "--run <id>",
    "Постоянный ID текущего участия: run.id, не RUN-token",
  );
const assignmentOptions = (command: Command) => {
  command.requiredOption("--title <text>", "Непустое однострочное название поручения");
  return textOption(command, "description", "Полное поручение в Markdown");
};
const connectionOptions = (command: Command) => {
  command
    .option("--client <name>", "Название клиента; не идентификатор агента")
    .option("--source-session-id <id>", "Внешний ID сессии клиента, не ветки Relay")
    .option(
      "--user-name <name>",
      "Человек, от имени которого действует агент; приоритет над RELAY_USER_NAME и Git",
    )
    .option(
      "--user-email <email>",
      "Email человека; явная пара не дополняется окружением/Git, отсутствующий компонент — null",
    );
  return textOption(command, "reason", "Полная причина подключения или передачи в Markdown");
};
const checkpointFields = ["summary", "body", "done", "remaining", "nextStep", "checks"] as const;
const checkpointOptions = (command: Command, accept: boolean) => {
  ownerOptions(command).requiredOption("--title <text>", "Название новой неизменяемой точки");
  for (const [field, label] of [
    ["summary", "Краткая аннотация; не создаётся автоматически из body"],
    [
      "body",
      "Обязательный непустой полный Markdown намерения, промежуточного материала или результата",
    ],
    ["done", "Что сделано, полный Markdown"],
    ["remaining", "Остаток и блокеры, полный Markdown"],
    ["nextStep", "Следующее действие, полный Markdown"],
    ["checks", "Проверки и фактические результаты, полный Markdown"],
  ] as const)
    textOption(command, field, label);
  command.option(
    "--references <refs...>",
    "Ссылки на предметные сущности: ключ, ID или kind:ID; подписи сохраняет Core",
  );
  if (accept)
    command.option(
      "--accept <ids...>",
      "Явно принять результаты завершённых прямых детей: постоянные session.id, не ключи S-token",
    );
  return command;
};

/** Весь текст читается до единственного предметного вызова; ревизия не перечитывается. */
function mutation<T>(
  group: Command,
  runtime: Runtime,
  definition: {
    name: string;
    description: string;
    arguments?: Record<string, string>;
    details?: string;
    example: string;
    configure: (command: Command) => unknown;
    fields: readonly string[];
    connection?: "start" | "attach" | "resume" | "takeover";
    schema: z.ZodType<T>;
    call: (
      context: CommandContext,
      value: T,
      actor: string,
    ) => Promise<contract.WorkHistoryMutation>;
  },
): void {
  registerCommand<Options>(group, runtime, {
    ...definition,
    details: `${definition.details ?? ""}\n${details}`,
    examples: [[definition.example, definition.description]],
    async run(context, input) {
      const texts = await readTextFields(context, input.options, definition.fields);
      const options = { ...input.options };
      for (const field of definition.fields) {
        delete options[field];
        delete options[`${field}File`];
      }
      const { run, accept, userName, userEmail, ...fields } = options;
      const actor = author(context);
      const connection = definition.connection
        ? await workConnectionMetadata(
            context,
            { userName, userEmail },
            definition.connection === "attach",
          )
        : {};
      const value = parse(
        definition.schema,
        {
          ...fields,
          ...texts,
          ...connection,
          ...(input.optionalArgument() === undefined ? {} : { ref: input.argument() }),
          ...(run === undefined ? {} : { runId: run }),
          ...(accept === undefined ? {} : { acceptedSessionIds: accept }),
          requestId: requestId(input.options),
          actor,
        },
        "запись истории работы",
      );
      const data = await definition.call(context, value, actor);
      return {
        data,
        text: (options) => workSavedText(data, definition.description, options, invokeFor(context)),
      };
    },
  });
}

export function registerWorkHistory(program: Command, runtime: Runtime): void {
  const session = commandGroup(program, {
    name: "session",
    description: "Ветки работы и история участия агентов",
    details,
    examples: [["npx @oim-dev/relay-cli session list --unfinished", "Найти незавершённые ветки"]],
  });
  const checkpoint = commandGroup(program, {
    name: "checkpoint",
    description: "Намерения, промежуточные материалы и результаты в Markdown",
    details,
    examples: [["npx @oim-dev/relay-cli checkpoint get CP-token", "Прочитать полный материал"]],
  });
  registerCommand<Options>(session, runtime, {
    name: "intents <reference>",
    description: "Найти незакрытые намерения без чтения всей истории",
    arguments: sessionArgument,
    details:
      "По умолчанию только сама ветка; --include-children включает всех потомков. Сервер определяет незакрытые intent по последующим result/cancel. Полный Markdown каждой точки доступен через checkpoint get.",
    examples: [
      [
        "npx @oim-dev/relay-cli session intents S-token --include-children --limit 10",
        "Найти незавершённые намерения поддерева",
      ],
    ],
    configure: (command) =>
      paging(command).option(
        "--include-children [value]",
        "Включить потомков; true/false, при флаге true",
        boolean,
      ),
    async run(context, input) {
      const command = ["session", "intents", input.argument()];
      const { limit, cursor, ...filters } = input.options;
      const query = offsetQuery(context, input.options, command, filters);
      const request = parse(
        contract.workOpenIntentsQuerySchema,
        { ...filters, ...query, ref: input.argument() },
        "открытые намерения",
      );
      const data = await context.backend.workHistory.openIntents(request);
      return {
        data,
        page: pageResult(context, command, filters, query, data),
        text: (options) => intentsText(data, request, options, invokeFor(context)),
      };
    },
  });
  registerCommand<Options>(session, runtime, {
    name: "list",
    description: "Найти ветки работы страницами, без полных поручений",
    details:
      "Незавершённость определяется только состоянием pending/open/paused. Одинаковые имя или модель не означают одного агента. Для полного поручения используйте session get.",
    examples: [
      ["npx @oim-dev/relay-cli session list --unfinished --limit 10", "Обзор незавершённых веток"],
    ],
    configure: (command) =>
      paging(command)
        .option(
          "--unfinished [value]",
          "Только незавершённые; false — только закрытые, true по умолчанию при флаге",
          boolean,
        )
        .option("--status <status>", "Состояние: pending, open, paused, completed, cancelled")
        .option("--parent <reference>", "Прямые дети ветки S-token/ID; null — только корни")
        .option(
          "--actor-filter <actor>",
          "Автор хотя бы одного сохранённого участия; не глобальный --actor",
        )
        .option("--q <text>", "Поиск по ключу, названию и полному поручению"),
    async run(context, input) {
      const { limit, cursor, ...filters } = input.options;
      const command = ["session", "list"];
      const query = offsetQuery(context, input.options, command, filters);
      const { actorFilter, parent, ...rest } = filters;
      const request = parse(
        contract.workSessionsQuerySchema,
        {
          ...rest,
          ...query,
          actor: actorFilter,
          parent: parent === "null" ? null : parent,
        },
        "поиск веток",
      );
      const data = await context.backend.workHistory.list(request);
      return {
        data,
        page: pageResult(context, command, filters, query, data),
        text: (options) => sessionListText(data, request, options, invokeFor(context)),
      };
    },
  });
  registerCommand(session, runtime, {
    name: "get <reference>",
    description: "Прочитать полное поручение, итог и текущее участие",
    arguments: sessionArgument,
    details:
      "Карточка содержит ревизию ветки и currentRun.id для --run. session intents <reference> — все открытые намерения, включая старые; session context <reference> — полные материалы страницами; session tree <reference> — иерархия; session history <reference> --include-children — хронология с потомками. После записи используйте get для проверки сохранённого содержания.",
    examples: [["npx @oim-dev/relay-cli session get S-token", "Прочитать ветку и её ревизию"]],
    async run(context, input) {
      const data = await context.backend.workHistory.get({ ref: input.argument() });
      return { data, text: (options) => sessionText(data, options, invokeFor(context)) };
    },
  });
  registerCommand<Options>(session, runtime, {
    name: "tree <reference>",
    description: "Прочитать иерархию ветки с полными итогами поддерева",
    arguments: sessionArgument,
    configure: paging,
    details:
      "Глубина отсчитывается от выбранного корня. Родитель вне страницы или поддерева не исчезает. Ветки и участия считаются отдельно.",
    examples: [
      ["npx @oim-dev/relay-cli session tree S-token --limit 10", "Первая страница дерева"],
    ],
    async run(context, input) {
      const command = ["session", "tree", input.argument()];
      const filters = {};
      const query = offsetQuery(context, input.options, command, filters);
      const request = parse(
        contract.workTreeQuerySchema,
        { ...filters, ...query, ref: input.argument() },
        "дерево веток",
      );
      const data = await context.backend.workHistory.tree(request);
      return {
        data,
        page: pageResult(context, command, filters, query, data),
        text: (options) => sessionTreeText(data, options, invokeFor(context)),
      };
    },
  });
  registerCommand<Options>(session, runtime, {
    name: "history [reference]",
    description: "Хронология ветки или всего проекта страницами",
    arguments: sessionArgument,
    details:
      "Без reference — весь проект. Lifecycle выводится сервером из сохранённых записей, не из журнала команд. Для полных материалов страницы ветки используйте session context.",
    examples: [
      [
        "npx @oim-dev/relay-cli session history S-token --include-children --order asc",
        "Хронология дерева с начала",
      ],
    ],
    configure: (command) =>
      paging(command)
        .option(
          "--include-children [value]",
          "Включить всех потомков; true/false, при флаге true",
          boolean,
        )
        .option("--order <order>", "Порядок asc (с начала) или desc (с конца, по умолчанию)")
        .option(
          "--kind <kind>",
          "Тип: session-created, session-forked, session-closed, run-started, run-ended, checkpoint",
        ),
    async run(context, input) {
      const ref = input.optionalArgument();
      const command = ["session", "history", ...(ref ? [ref] : [])];
      const { limit, cursor, ...filters } = input.options;
      const query = offsetQuery(context, input.options, command, filters);
      const request = parse(
        contract.workHistoryQuerySchema,
        { ...filters, ...query, ref },
        "хронология",
      );
      const data = await context.backend.workHistory.history(request);
      return {
        data,
        page: pageResult(context, command, filters, query, data),
        text: (options) => historyText(data, request, options, invokeFor(context)),
      };
    },
  });
  registerCommand<Options>(session, runtime, {
    name: "context <reference>",
    description: "Полное поручение и все материалы выбранной страницы самой ветки",
    arguments: sessionArgument,
    configure: paging,
    details:
      "История самой ветки, без потомков, от новых записей к старым. Это одна явно обозначенная страница, не весь контекст проекта. Продолжайте той же командой с --cursor; все открытые намерения, включая старые, доступны через session intents <reference>.",
    examples: [
      [
        "npx @oim-dev/relay-cli session context S-token --limit 10",
        "Прочитать последние полные материалы",
      ],
    ],
    async run(context, input) {
      const command = ["session", "context", input.argument()];
      const filters = {};
      const query = offsetQuery(context, input.options, command, filters);
      const request = parse(
        contract.workContextQuerySchema,
        { ...filters, ...query, ref: input.argument() },
        "контекст ветки",
      );
      const data = await context.backend.workHistory.context(request);
      return {
        data,
        page: pageResult(context, command, filters, query, data.history),
        text: (options) => sessionContextText(data, options, invokeFor(context)),
      };
    },
  });
  registerCommand(checkpoint, runtime, {
    name: "get <reference>",
    description: "Прочитать точку целиком: Markdown, автора, участие и сохранённые ссылки",
    arguments: { reference: "Точка любого типа: CP-token, постоянный ID или work-checkpoint:ID" },
    details:
      "Точка неизменяема. Состояние намерения определяется последующими точками: session history <ветка из карточки> --order asc. Актуальная ревизия и участие владельца — session get <ветка>; исходное намерение — checkpoint get <intent из карточки>. Поле nextStep является сохранённым пользовательским Markdown, а не подсказкой CLI.",
    examples: [["npx @oim-dev/relay-cli checkpoint get CP-token", "Прочитать полный материал"]],
    async run(context, input) {
      const data = await context.backend.workHistory.checkpoint({ ref: input.argument() });
      return { data, text: (options) => checkpointText(data, options, invokeFor(context)) };
    },
  });
  mutation(session, runtime, {
    name: "start",
    description: "Создать корневую ветку и первое участие",
    example:
      "npx @oim-dev/relay-cli session start --title 'Проверить API' --description 'Поручение и критерии проверки' --actor agent",
    details:
      "Ревизия не нужна. Результат содержит run.id для дальнейшего --run. Пользователь: явные --user-name/--user-email → RELAY_USER_NAME/RELAY_USER_EMAIL → effective Git user.name/user.email только внутри репозитория исходного cwd. Источники пары не смешиваются. Это заявленная атрибуция, не аутентификация; Git не изменяется.",
    configure: (command) => connectionOptions(assignmentOptions(recordOptions(command))),
    fields: ["description", "reason"],
    connection: "start",
    schema: contract.workSessionStartSchema,
    call: (context, value, actor) => context.backend.workHistory.start(value, actor),
  });
  mutation(session, runtime, {
    name: "fork <reference>",
    description: "Создать ожидающую дочернюю ветку из открытого намерения",
    arguments: checkpointArgument,
    details:
      "Аргумент — CHECKPOINT, не ветка. --if-revision и --run относятся к родительской ветке исходного intent. Дочерний run не создаётся; передайте childSession адрес исполнителю для session attach.",
    example:
      "npx @oim-dev/relay-cli session fork CP-token --title 'Проверить ошибки' --description 'Проверить ответы API' --run run-id --if-revision 2 --actor agent",
    configure: (command) => assignmentOptions(ownerOptions(command)),
    fields: ["description"],
    schema: contract.workSessionForkSchema,
    call: (context, value, actor) => context.backend.workHistory.fork(value, actor),
  });
  for (const operation of ["attach", "resume", "takeover"] as const) {
    const description = {
      attach: "Подключить первое участие к ожидающей ветке",
      resume: "Возобновить приостановленную ветку новым участием",
      takeover: "Явно передать открытую ветку новому участию",
    }[operation];
    mutation(session, runtime, {
      name: `${operation} <reference>`,
      description,
      arguments: sessionArgument,
      details:
        "Создаётся новый run.id. У takeover непустая reason обязательна; прежний run теряет право записи. Пользователь: явная пара --user-name/--user-email → пара RELAY_USER_NAME/RELAY_USER_EMAIL → Git исходного cwd (кроме attach). Источники не смешиваются. Attach без явной/env пары оставляет наследование пользователя создателя Core; передавайте субагенту пользовательский контекст родителя. Git-контекст всегда клиентский. Атрибуция не является аутентификацией.",
      example: `npx @oim-dev/relay-cli session ${operation} S-token --reason 'Продолжаю поручение' --if-revision 1 --actor agent`,
      configure: (command) => connectionOptions(branchOptions(command)),
      fields: ["reason"],
      connection: operation,
      schema: contract.workHistoryOperations[operation].input,
      call: (context, value, actor) => context.backend.workHistory[operation](value, actor),
    });
  }
  mutation(session, runtime, {
    name: "pause <reference>",
    description: "Приостановить ветку, сохранив причину окончания участия",
    arguments: sessionArgument,
    example:
      "npx @oim-dev/relay-cli session pause S-token --reason 'Нужны исходные данные' --run run-id --if-revision 3 --actor agent",
    configure: (command) =>
      textOption(ownerOptions(command), "reason", "Обязательная непустая причина паузы в Markdown"),
    fields: ["reason"],
    schema: contract.workSessionPauseSchema,
    call: (context, value, actor) => context.backend.workHistory.pause(value, actor),
  });
  mutation(session, runtime, {
    name: "complete <reference>",
    description: "Завершить ветку и участие с полным итогом",
    arguments: sessionArgument,
    details:
      "Core проверяет открытые намерения и явное принятие результатов детей. Завершение ребёнка само по себе не означает принятия родителем.",
    example:
      "npx @oim-dev/relay-cli session complete S-token --result 'Проверки пройдены; результаты описаны в точках' --run run-id --if-revision 4 --actor agent",
    configure: (command) =>
      textOption(
        ownerOptions(command),
        "result",
        "Обязательный непустой итог всей ветки в Markdown",
      ),
    fields: ["result"],
    schema: contract.workSessionCompleteSchema,
    call: (context, value, actor) => context.backend.workHistory.complete(value, actor),
  });
  mutation(session, runtime, {
    name: "cancel <reference>",
    description: "Отменить ветку с полной причиной, без неявного принятия детей",
    arguments: sessionArgument,
    details:
      "Для open-ветки обязателен --run. У pending/paused текущего участия нет. Открытые намерения и незакрытые дети проверяются Core.",
    example:
      "npx @oim-dev/relay-cli session cancel S-token --result 'Поручение больше не требуется' --if-revision 1 --actor agent",
    configure: (command) =>
      textOption(
        branchOptions(command).option(
          "--run <id>",
          "ID текущего участия; обязателен для open, не RUN-token",
        ),
        "result",
        "Обязательная непустая причина отмены в Markdown",
      ),
    fields: ["result"],
    schema: contract.workSessionCancelSchema,
    call: (context, value, actor) => context.backend.workHistory.cancel(value, actor),
  });
  mutation(checkpoint, runtime, {
    name: "open <reference>",
    description: "Открыть намерение новой неизменяемой точкой",
    arguments: sessionArgument,
    example:
      "npx @oim-dev/relay-cli checkpoint open S-token --title 'Проверить API' --body 'План проверки и ожидаемый результат' --run run-id --if-revision 1 --actor agent",
    configure: (command) => checkpointOptions(command, false),
    fields: checkpointFields,
    schema: contract.workCheckpointOpenSchema,
    call: (context, value, actor) => context.backend.workHistory.openCheckpoint(value, actor),
  });
  for (const [name, operation, description] of [
    ["save", "saveCheckpoint", "Сохранить промежуточный материал открытого намерения"],
    ["complete", "completeCheckpoint", "Закрыть намерение новой точкой результата"],
    ["cancel", "cancelCheckpoint", "Закрыть намерение новой точкой отмены"],
  ] as const) {
    mutation(checkpoint, runtime, {
      name: `${name} <reference>`,
      description,
      arguments: checkpointArgument,
      details:
        "Адрес — исходный intent, а не последняя progress-точка. Новая точка не изменяет исходную. --accept явно принимает результаты детей; пустой/отсутствующий набор ничего не принимает. body обязателен и не заменяется summary.",
      example: `npx @oim-dev/relay-cli checkpoint ${name} CP-token --title 'Результат проверки' --body 'Факты, проверки и следующий шаг' --run run-id --if-revision 2 --actor agent`,
      configure: (command) => checkpointOptions(command, true),
      fields: checkpointFields,
      schema: contract.workHistoryOperations[operation].input,
      call: (context, value, actor) => context.backend.workHistory[operation](value, actor),
    });
  }
}
