import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { graphMutationSchema } from "@relay/core/domain/entity-graph";
import type { GraphQuery } from "@relay/core/domain/entity-graph";
import { parse } from "@relay/core/domain/validation";
import { AppError, invariant } from "@relay/core/shared/errors";
import { commandGroup, registerCommand } from "../command.js";
import { author } from "../context.js";
import type { Runtime } from "../context.js";
import { integer } from "../options.js";
import { graphText, fullContextText, graphSavedText } from "../presentation/graph.js";
import {
  paging,
  offsetQuery,
  pageResult,
  textOption,
  readTextFields,
  commandInvocation,
} from "../command-kit.js";

/** Некорректный JSON является ошибкой ввода, а не отказом файлового хранилища. */
function readOperations(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new AppError(
      "INVALID_JSON",
      "Параметр --json должен содержать корректный JSON-массив операций",
    );
  }
}

/** Общие графовые действия одинаковы для оператора и агентского CLI. */
export function registerGraph(program: Command, runtime: Runtime): void {
  const inspect =
    program.commands.find((command) => command.name() === "inspect") ??
    commandGroup(program, {
      name: "inspect",
      description: "Техническое чтение сущностей и графа",
      details: "Диагностическое чтение без изменения данных.",
      examples: [["npx @oim-dev/relay-cli inspect graph list", "Прочитать граф"]],
    });
  const doctor =
    program.commands.find((command) => command.name() === "doctor") ??
    commandGroup(program, {
      name: "doctor",
      description: "Диагностика и явное исправление проекта",
      details: "Ремонт выполняется явно; перед записью сохраните резервную копию.",
      examples: [["npx @oim-dev/relay-cli doctor check", "Проверить проект"]],
    });
  const repair = commandGroup(doctor, {
    name: "graph",
    description: "Явный ремонт диагностических отношений",
    details:
      "Не заменяет предметные операции задач, документов и планов. Перед записью прочитайте inspect graph list.",
    examples: [["npx @oim-dev/relay-cli doctor graph link --help", "Изучить условия ремонта"]],
  });
  const group = commandGroup(inspect, {
    name: "graph",
    description: "Связи всех сущностей и контекст проекта",
    details:
      "Сущность задаётся ключом, ID или kind:ID. Все связи явно сохранены в Core; продуктовые поля не создают рёбер. Типы расширяемы, циклы допустимы. Прямая запись графа предназначена для диагностики и ремонта; продуктовые действия выполняйте предметными командами.",
    examples: [
      ["npx @oim-dev/relay-cli inspect graph list", "Найти сущности и прочитать версию"],
      [
        "npx @oim-dev/relay-cli inspect graph context SCENARIO-1 --format json",
        "Восстановить цепочку для агента",
      ],
    ],
  });
  registerCommand<
    Omit<GraphQuery, "offset" | "version" | "limit"> & { cursor?: string; limit?: number }
  >(group, runtime, {
    name: "list",
    description: "Прочитать граф или выбранный подграф с продолжением",
    details:
      "Узлы и рёбра имеют отдельные страницы одного снимка: --limit ограничивает каждый список. Курсор продолжает оба списка. Сводное количество — сумма узлов и рёбер, не число сущностей. Конец страниц не отменяет фильтры и границу глубины; для всей достижимой компоненты используйте context.",
    examples: [
      ["npx @oim-dev/relay-cli inspect graph list --root WEB-24 --limit 20", "Прочитать связи"],
    ],
    configure: (command) => {
      command.option("--root <address>", "Ключ или ID корня; без него весь проект");
      return paging(
        command
          .option("--type <type>", "Фильтр типа отношений")
          .option("--direction <direction>", "both, outgoing или incoming")
          .option("--profile <profile>", "all — полный обход; context — совместимое имя all")
          .option("--depth <n>", "Глубина обхода 0–100", integer(0, 100))
          .option("--q <text>", "Поиск сущностей по ключу, адресу и названию"),
      );
    },
    run: async (context, input) => {
      const { cursor: _cursor, limit: _limit, ...filters } = input.options;
      const path = ["inspect", "graph", "list"];
      const pagination = offsetQuery(context, input.options, path, filters);
      const query: GraphQuery = { ...filters, ...pagination };
      const data = await context.backend.graph.read(query);
      return {
        data,
        meta: { paginationUnit: "nodes-and-edges", limitPerCollection: pagination.limit },
        page: pageResult(context, path, filters, pagination, {
          items: [...data.nodes, ...data.edges],
          total: data.totalNodes + data.totalEdges,
          nextOffset: data.nextOffset,
          version: data.version,
        }),
        text: (options) =>
          graphText(
            data,
            query,
            options,
            query.root
              ? [
                  {
                    label: "Прочитать всю достижимую компоненту",
                    command: commandInvocation(context, [
                      "inspect",
                      "graph",
                      "context",
                      query.root,
                    ]),
                  },
                ]
              : [
                  {
                    label: "Выбрать корень полного контекста: справка",
                    command: commandInvocation(context, ["inspect", "graph", "context", "--help"]),
                  },
                ],
          ),
      };
    },
  });
  registerCommand(group, runtime, {
    name: "context <root>",
    description: "Получить полный контекст сущности одним вызовом",
    arguments: { root: "Ключ, ID или kind:ID исходной сущности любого зарегистрированного вида" },
    details:
      "Возвращает все узлы и рёбра достижимой компоненты в обоих направлениях, включая циклы и параллельные связи. Успешный ответ всегда полный. Глубина и страницы не применяются; ограничение Core возвращает ошибку, а не усечённый успех.",
    examples: [
      ["npx @oim-dev/relay-cli inspect graph context WEB-24", "Прочитать полное окружение задачи"],
      [
        "npx @oim-dev/relay-cli inspect graph context WEB-24 --format json",
        "Получить структурированный граф для агента",
      ],
    ],
    run: async (context, input) => {
      const data = await context.backend.graph.context({ root: input.argument() });
      return {
        data,
        text: (options) =>
          fullContextText(data, options, [
            {
              label: "Прочитать пояснения отношений (ограниченный обзор)",
              command: commandInvocation(context, [
                "inspect",
                "graph",
                "list",
                "--root",
                input.argument(),
              ]),
            },
            {
              label: "Разрешить адрес корня и получить команду чтения содержания",
              command: commandInvocation(context, ["inspect", "resolve", input.argument()]),
            },
          ]),
      };
    },
  });
  type WriteOptions = {
    from?: string;
    to?: string;
    type?: string;
    description?: string;
    ifVersion: string;
    requestId?: string;
    json?: string;
  };
  for (const action of ["link", "update", "unlink", "apply"] as const)
    registerCommand<WriteOptions>(repair, runtime, {
      name: action === "unlink" || action === "update" ? `${action} <id>` : action,
      description: {
        link: "Установить произвольную направленную связь",
        update: "Изменить пояснение связи",
        unlink: "Отозвать связь",
        apply: "Применить атомарный пакет изменений",
      }[action],
      ...(action === "unlink" || action === "update"
        ? { arguments: { id: "ID явно установленного отношения" } }
        : {}),
      details:
        "Диагностика и ремонт сохранённых связей. Требуется прочитанная версия графа и автор. После потери ответа перечитайте связи, затем решайте, нужно ли новое изменение; request-id служит только корреляции. Запись графа не меняет продуктовые линки и статусы.",
      examples: [
        [
          {
            link: "npx @oim-dev/relay-cli doctor graph link --actor agent --from WEB-24 --to DOC-1 --type references --if-version VERSION",
            update:
              'npx @oim-dev/relay-cli doctor graph update EDGE_ID --actor agent --description "Основание решения" --if-version VERSION',
            unlink:
              "npx @oim-dev/relay-cli doctor graph unlink EDGE_ID --actor agent --if-version VERSION",
            apply: `npx @oim-dev/relay-cli doctor graph apply --actor agent --json '[{"action":"add","from":"WEB-24","to":"DOC-1","type":"references","description":"Основание решения"}]' --if-version VERSION`,
          }[action],
          "Изменить диагностические связи; VERSION и EDGE_ID замените прочитанными значениями",
        ],
      ],
      configure: (command) => {
        command
          .requiredOption("--if-version <version>", "Версия из inspect graph list/context")
          .option(
            "--request-id <id>",
            "Идентификатор корреляции, не дедупликации; по умолчанию UUID",
          );
        if (action === "link")
          command
            .requiredOption("--from <address>", "Ключ или ID начала связи")
            .requiredOption("--to <address>", "Ключ или ID конца связи")
            .requiredOption("--type <type>", "Произвольный тип отношения");
        if (action === "link" || action === "update")
          textOption(command, "description", "Пояснение назначения связи в Markdown");
        if (action === "apply")
          command.requiredOption(
            "--json <json>",
            "Массив операций add/update/remove, максимум 100",
          );
        return command;
      },
      run: async (context, input) => {
        const options = {
          ...input.options,
          ...(await readTextFields(context, input.options, ["description"])),
        };
        if (action === "update")
          invariant(
            options.description !== undefined,
            "INVALID_ARGUMENT",
            "Передайте --description или --description-file; пустая строка явно очищает пояснение",
          );
        const operations: unknown =
          action === "apply"
            ? readOperations(options.json ?? "[]")
            : action === "link"
              ? [
                  {
                    action: "add",
                    from: options.from ?? "",
                    to: options.to ?? "",
                    type: options.type,
                    description: options.description ?? "",
                  },
                ]
              : [
                  {
                    action: action === "unlink" ? "remove" : "update",
                    id: input.argument(),
                    ...(action === "update" ? { description: options.description ?? "" } : {}),
                  },
                ];
        const command = parse(
          graphMutationSchema,
          {
            operations,
            ifVersion: options.ifVersion,
            requestId: options.requestId ?? randomUUID(),
          },
          "пакет отношений",
        );
        const data = await context.backend.graph.mutate(command, author(context));
        return {
          data,
          text: (options) =>
            graphSavedText(data, options, [
              {
                label: "Проверить сохранённые отношения",
                command: commandInvocation(context, ["inspect", "graph", "list"]),
              },
              {
                label: "Проверить целостность проекта",
                command: commandInvocation(context, ["doctor", "check"]),
              },
            ]),
        };
      },
    });
}
