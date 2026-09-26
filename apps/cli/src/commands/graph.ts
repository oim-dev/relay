import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { graphMutationSchema } from "@relay/core/domain/entity-graph";
import type { GraphQuery } from "@relay/core/domain/entity-graph";
import { parse } from "@relay/core/domain/validation";
import { AppError } from "@relay/core/shared/errors";
import { GraphService } from "@relay/core/application/graph/service";
import { commandGroup, registerCommand } from "../command.js";
import { author } from "../context.js";
import type { Runtime } from "../context.js";
import { integer } from "../options.js";
import { graphText, fullContextText, graphSavedText } from "../presentation/graph.js";

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
  const group = commandGroup(program, {
    name: "graph",
    description: "Связи всех сущностей и контекст проекта",
    details:
      "Сущность задаётся ключом, ID или kind:ID. Все связи явно сохранены в Core; продуктовые поля не создают рёбер. Типы расширяемы, циклы допустимы. Прямая запись графа предназначена для диагностики и ремонта; продуктовые действия выполняйте предметными командами.",
    examples: [
      ["relay-cli graph list", "Найти сущности и прочитать версию"],
      ["relay-cli graph context SCENARIO-1 --format json", "Восстановить цепочку для агента"],
    ],
  });
  for (const action of ["migrate", "reindex"] as const)
    registerCommand(group, runtime, {
      name: action,
      description:
        action === "migrate"
          ? "Перенести единый JSON графа в раздельное хранилище v2"
          : "Восстановить индексы графа из постоянных записей",
      details:
        "Только локальный режим выбранного проекта. Перед миграцией остановите старые клиенты. Прерванная операция возобновляется; ID, ревизии и квитанции сохраняются. Исходник v1 остаётся резервной копией.",
      examples: [
        [
          `relay-cli --local --config .relay/config.json graph ${action}`,
          "Обслужить выбранную базу связей",
        ],
      ],
      run: async (context) => {
        const workspace = context.backend.localWorkspace;
        if (!workspace)
          throw new AppError(
            "LOCAL_REQUIRED",
            "Укажите --local и --config проектного .relay/config.json для обслуживания графа",
          );
        const data = await new GraphService(workspace)[action]();
        return {
          data,
          text: `${action === "migrate" ? "Хранилище связей готово к работе в формате v2." : "Индексы связей восстановлены."}\nСвязей: ${data.edges}\nРевизия: ${data.revision}`,
        };
      },
    });
  registerCommand<GraphQuery & { snapshotVersion?: string }>(group, runtime, {
    name: "list",
    description: "Прочитать граф или выбранный подграф с продолжением",
    details:
      "Узлы и сохранённые рёбра читаются страницами одного снимка, без скрытого отсечения документов и приложений. depthLimited обозначает границу глубины, nextOffset — продолжение страницы. Продуктовый линк без явной записи Core не появляется в графе.",
    examples: [["relay-cli graph list --root WEB-24 --limit 20", "Прочитать связи"]],
    configure: (command) => {
      command.option("--root <address>", "Ключ или ID корня; без него весь проект");
      return command
        .option("--type <type>", "Фильтр типа отношений")
        .option("--direction <direction>", "both, outgoing или incoming")
        .option("--profile <profile>", "all — полный обход; context — совместимое имя all")
        .option("--depth <n>", "Глубина обхода 0–100", integer(0, 100))
        .option("--q <text>", "Поиск сущностей по ключу, адресу и названию")
        .option("--offset <n>", "Смещение страницы", integer(0, Number.MAX_SAFE_INTEGER))
        .option("--limit <n>", "Размер страницы 1–100", integer(1, 100))
        .option(
          "--snapshot-version <version>",
          "Версия первой страницы графа; отличается от глобального --version CLI",
        );
    },
    run: async (context, input) => {
      const { snapshotVersion, ...options } = input.options;
      const query: GraphQuery = {
        ...options,
        ...(snapshotVersion === undefined ? {} : { version: snapshotVersion }),
      };
      const data = await context.backend.graph.read(query);
      return { data, text: (options) => graphText(data, query, options) };
    },
  });
  registerCommand(group, runtime, {
    name: "context <root>",
    description: "Получить полный контекст сущности одним вызовом",
    arguments: { root: "Ключ, ID или kind:ID исходной сущности любого зарегистрированного вида" },
    details:
      "Возвращает все узлы и рёбра достижимой компоненты в обоих направлениях, включая циклы и параллельные связи. Успешный ответ всегда полный. Глубина и страницы не применяются. При превышении бюджета вернётся ошибка; --max-bytes позволяет явно увеличить лимит.",
    examples: [
      ["relay-cli graph context WEB-24", "Прочитать полное окружение задачи"],
      [
        "relay-cli graph context WEB-24 --format json --max-bytes 1048576",
        "Получить структурированный граф для агента",
      ],
    ],
    run: async (context, input) => {
      const data = await context.backend.graph.context({ root: input.argument() });
      return { data, text: (options) => fullContextText(data, options) };
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
    registerCommand<WriteOptions>(group, runtime, {
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
        "Диагностика и ремонт сохранённых связей. Требуется прочитанная версия графа и автор. Повтор после потери ответа выполняйте с тем же request-id, версией и содержимым. Запись графа не меняет продуктовые линки и статусы.",
      examples: [
        [
          "relay-cli --actor agent graph link --from WEB-24 --to DOC-1 --type references --if-version VERSION",
          "Прикрепить контекстный материал",
        ],
      ],
      configure: (command) => {
        command
          .requiredOption("--if-version <version>", "Версия из graph list/context")
          .option("--request-id <id>", "Ключ безопасного повтора; по умолчанию генерируется");
        if (action === "link")
          command
            .requiredOption("--from <address>", "Ключ или ID начала связи")
            .requiredOption("--to <address>", "Ключ или ID конца связи")
            .requiredOption("--type <type>", "Произвольный тип отношения");
        if (action === "link" || action === "update")
          command.option("--description <markdown>", "Пояснение назначения связи в Markdown");
        if (action === "apply")
          command.requiredOption(
            "--json <json>",
            "Массив операций add/update/remove, максимум 100",
          );
        return command;
      },
      run: async (context, input) => {
        const options = input.options;
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
        return { data, text: graphSavedText(data) };
      },
    });
}
