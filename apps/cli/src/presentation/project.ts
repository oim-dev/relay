import type { Config } from "@relay/core/domain/config";
import type { ServerContextResponse } from "@relay/contracts";
import type {
  ProjectRegistrationReceipt,
  ProjectUnregistrationReceipt,
} from "@relay/contracts/server-context";
import type { EntityDetail, EntitySaved } from "@relay/contracts/entities";
import { defaultDocumentSections } from "@relay/contracts/entities";
import type { ProjectSettings } from "@relay/contracts/entities/project-settings";
import { defaultTextOptions, type TextOptions } from "./theme.js";
import { safeText } from "./safe.js";
import { section, table, wrap } from "./layout.js";
import { cardText, listText, receiptText, type OutputField, type OutputCommand } from "./common.js";
import { shellCommand } from "../command-kit.js";
import type { ConnectionInfo } from "../backend/connect.js";

export function initializedText(
  configPath: string,
  storageDir: string,
  options: TextOptions,
  nextCommand: string,
  readCommand: string,
): string {
  return receiptText(
    {
      title: "✓ Проект инициализирован",
      fields: [
        ["Конфигурация", configPath, "opaque"],
        ["Хранилище", storageDir, "opaque"],
      ],
      commands: [
        {
          label: "Проверить созданный проект и пути",
          command: readCommand,
        },
        {
          label: "Следующий шаг: подготовить паспорт продукта",
          command: nextCommand,
        },
      ],
    },
    options,
  );
}

export function configText(
  config: Config,
  configPath: string,
  root: string,
  options: TextOptions,
  connection?: ConnectionInfo,
  readCommand?: string,
): string {
  const client = connection?.clientConfig;
  const http = connection?.transport === "http";
  const separateClient = client && client.path !== configPath;
  return cardText(
    {
      title: `Конфигурация — ${config.projectSettings?.entityKey ?? "PROJECT"} — ${config.projectSettings?.name ?? "проект"}`,
      fields: [
        ["Ревизия проекта", config.projectSettings?.revision],
        ["Slug", config.projectSettings?.slug],
        ["ID проекта", connection?.projectId ?? config.projectId],
        ["Версия конфигурации", config.version],
      ],
      sections: [
        {
          title: "Подключение и пути",
          body: cardText(
            {
              title: "",
              fields: [
                [
                  "Текущий доступ",
                  http ? `HTTP: ${connection.serverUrl}` : "Прямой Core (local)",
                  "opaque",
                ],
                [
                  "Источник URL",
                  connection?.serverUrlSource
                    ? {
                        flag: "--server-url",
                        env: "RELAY_SERVER_URL",
                        config: `${connection.serverUrlConfigField} ${client?.mode === "workspace" ? "реестра" : "конфига"} клиента`,
                      }[connection.serverUrlSource]
                    : undefined,
                ],
                [
                  "Выбор конфига клиента",
                  client
                    ? {
                        flag: "--config",
                        env: "RELAY_CONFIG",
                        discovered: "поиск вверх от cwd",
                      }[client.source]
                    : "без локального конфига",
                ],
                ["Режим конфига клиента", client?.mode],
                ...(separateClient
                  ? [
                      [
                        client.mode === "workspace" ? "Реестр клиента" : "Конфиг клиента",
                        client.path,
                        "opaque",
                      ] as OutputField,
                    ]
                  : []),
                [http ? "Конфиг проекта на сервере" : "Конфигурация", configPath, "opaque"],
                [http ? "Хранилище на сервере" : "Хранилище", root, "opaque"],
                ["URL в конфиге", config.server.url],
                ["Порт REST в конфиге", config.server.port],
                ["Порт MCP в конфиге", config.mcp?.port],
              ],
            },
            options,
          ),
        },
        {
          title: "Вывод CLI",
          body: wrap(
            `По умолчанию текст; JSON только через --format json. Лимит страницы по умолчанию: ${config.output.defaultLimit}.\noutput.format и output.maxBytes не управляют выводом CLI. Цветного ANSI нет.`,
            options.width,
          ),
        },
        {
          title: "Совместимые поля — не действующие правила досок",
          body: cardText(
            {
              title: "",
              fields: [
                ["storageDir (legacy)", config.storageDir],
                ["defaultStatus (legacy)", config.defaultStatus],
                ["readyStatuses (legacy)", config.readyStatuses.join(", ")],
                ...Object.entries(config.statuses).map(([name, rule]): OutputField => [
                  name,
                  `terminal=${rule.terminal}; satisfiesDependencies=${rule.satisfiesDependencies}; color=${rule.color ?? "не задан"}`,
                ]),
              ],
              sections: [
                {
                  title: "Границы",
                  body: wrap(
                    "Эти статусы не задают колонки, готовность или завершение зависимостей текущих задач. storageDir не переносит единую базу. projectSettings — проекция записи PROJECT, а не отдельный источник настроек; имя меняется через project update.",
                    options.width,
                  ),
                },
              ],
            },
            options,
          ),
        },
      ],
      commands: readCommand
        ? [{ label: "Прочитать проект и его ревизию", command: readCommand }]
        : [],
    },
    options,
  );
}

/** Контекст отказа init приходит из Core; машинная причина остаётся в исходном details. */
export function initializationBlockedText(
  message: string,
  configPath: string,
  dataRoot: string | undefined,
  readCommand: string,
  options: TextOptions,
  diagnostic = false,
  paths: string[] = [],
): string {
  return cardText(
    {
      title: message,
      fields: [
        ["Конфигурация", configPath, "opaque"],
        ["Хранилище", dataRoot, "opaque"],
      ],
      sections: diagnostic
        ? [
            {
              title: "Обнаруженные пути относительно хранилища",
              body: paths.map((path) => `- ${safeText(path)}`).join("\n"),
            },
            {
              title: "Дальнейшие действия",
              body: wrap(
                "Не повторяйте init. Остановите писателей и сохраните копию оставшихся файлов. Проверьте состояние; при утрате конфига или storage.json диагностика тоже может отказать. Восстановите отсутствующие файлы из проверенной копии, не создавайте новую базу поверх остатков.",
                options.width,
              ),
            },
          ]
        : [],
      commands: [
        {
          purpose: "recovery",
          label: diagnostic
            ? "Проверить хранилище без восстановления и записи"
            : "Прочитать существующий проект и пути; повторный init не нужен",
          command: readCommand,
        },
      ],
    },
    options,
  );
}

export function projectText(
  entity: EntityDetail,
  options: TextOptions,
  commands: OutputCommand[] = [],
): string {
  const project = entity.data;
  if (project.kind !== "project") return "Ответ не является проектом.";
  return cardText(
    {
      title: `${entity.key} — ${project.name}`,
      fields: [
        ["Ревизия", entity.revision],
        ["Slug", project.slug, "opaque"],
        ["ID проекта", entity.ref.id, "opaque"],
        ["Разделов документов", (project.documentSections ?? defaultDocumentSections).length],
      ],
      commands,
    },
    options,
  );
}

export function projectSettingsSavedText(
  settings: ProjectSettings,
  readCommand: string,
  options: TextOptions,
): string {
  return receiptText(
    {
      title: `✓ Настройки проекта сохранены: ${settings.name}`,
      fields: [
        ["Slug", settings.slug, "opaque"],
        ["Ревизия", settings.revision],
      ],
      commands: [{ label: "Прочитать сохранённый проект", command: readCommand }],
    },
    options,
  );
}

export function projectSavedText(
  saved: EntitySaved,
  readCommand: string,
  options: TextOptions = defaultTextOptions,
  name?: string,
): string {
  return receiptText(
    {
      title: `✓ Название проекта изменено: ${saved.key}${name ? ` — ${name}` : ""}`,
      fields: [
        ["Ревизия", saved.revision],
        ["ID проекта", saved.ref.id],
        ["Идентификатор запроса", saved.requestId],
      ],
      commands: [{ label: "Прочитать сохранённый проект", command: readCommand }],
    },
    options,
  );
}

export function registryProjectsText(
  catalog: ServerContextResponse,
  options: TextOptions,
  connection: {
    configPath?: string | undefined;
    endpoint: string;
    command: (tokens: string[]) => string;
  },
): string {
  const available = catalog.projects.find((project) => project.available);
  return listText(
    {
      title: catalog.mode === "workspace" ? "Проекты workspace" : "Проект local-сервера",
      filters: [
        ["Режим Server", catalog.mode],
        ["Сервер", connection.endpoint, "opaque"],
        [
          catalog.mode === "workspace" ? "Реестр на сервере" : "Конфиг на сервере",
          catalog.configPath,
          "opaque",
        ],
        ...(connection.configPath && connection.configPath !== catalog.configPath
          ? [["Конфиг клиента", connection.configPath, "opaque"] as OutputField]
          : []),
        ["Проект по умолчанию", catalog.defaultProject ?? "не выбран (нужен --project)", "opaque"],
      ],
      items: catalog.projects.map((item) => ({
        key: item.key,
        title: item.name,
        details: [
          `Состояние: ${item.available ? "доступен" : "недоступен"}`,
          ...(!item.available ? [`Конфигурация на сервере: ${item.configPath}`] : []),
          ...(item.error ? [`Причина: ${item.error}`] : []),
          ...(item.slug ? [`Slug: ${item.slug}`] : []),
          `ID${item.available ? "" : " регистрации (база не подтверждена)"}: ${item.id}`,
        ],
      })),
      emptyMessage: "Регистраций на этой странице нет.",
      commands: available
        ? [
            {
              label:
                "Прочитать выбранный проект и пути; для другого замените --project на ключ, ID или slug",
              command: connection.command(["--project", available.key, "config", "get"]),
            },
          ]
        : catalog.mode === "workspace"
          ? [
              {
                label: catalog.projects.length
                  ? "Доступных проектов на странице нет; проверьте причины на стороне Server. Условия регистрации"
                  : "Подключить существующий проект: условия регистрации",
                command: connection.command(["workspace", "project", "add", "--help"]),
              },
            ]
          : [],
    },
    options,
  );
}

export function registrySavedText(
  receipt:
    | { operation: "init"; data: { configPath: string } }
    | { operation: "add" | "remove"; data: ServerContextResponse; name: string },
  options: TextOptions,
  readCommand?: string,
): string {
  if (receipt.operation === "init")
    return receiptText(
      {
        title: "✓ Реестр workspace создан",
        fields: [
          ["Конфигурация", receipt.data.configPath],
          ["Регистраций", 0],
        ],
        commands: [
          {
            label: "Условия регистрации существующего проекта",
            command: shellCommand([
              "npx",
              "@oim-dev/relay-cli",
              "--config",
              receipt.data.configPath,
              "workspace",
              "project",
              "add",
              "--help",
            ]),
          },
        ],
      },
      options,
    );
  const project = receipt.data.projects.find((item) => item.key === receipt.name);
  return receiptText(
    {
      title: `${receipt.operation === "add" ? "✓ Регистрация проекта сохранена" : "Проект не зарегистрирован в workspace"}: ${receipt.name}`,
      fields: [
        ["Регистрация", receipt.name],
        ["Проект", project?.name],
        ["Состояние", project ? (project.available ? "доступен" : "недоступен") : undefined],
        ["Причина", project?.error],
        ["Реестр", receipt.data.configPath],
        ["Конфигурация проекта", project?.configPath],
        [
          "Данные",
          receipt.operation === "add"
            ? "Не создавались и не переносились."
            : "Данные проекта сохранены.",
        ],
      ],
      commands: readCommand
        ? [{ label: "Проверить каталог регистраций", command: readCommand }]
        : [],
    },
    options,
  );
}

export function registryCompactSavedText(
  receipt: ProjectRegistrationReceipt | ProjectUnregistrationReceipt,
  options: TextOptions,
  readCommand: string,
): string {
  return receiptText(
    {
      title: `${receipt.action === "register" ? "✓ Регистрация проекта сохранена" : receipt.removed ? "✓ Регистрация проекта удалена" : "Регистрация уже отсутствовала"}: ${receipt.key}`,
      fields: [
        ["Регистрация", receipt.key, "opaque"],
        ["Реестр на сервере", receipt.configPath, "opaque"],
        ...(receipt.action === "register"
          ? [
              ["Путь относительно реестра", receipt.entry.path, "opaque"] as OutputField,
              ["Конфиг относительно path/реестра", receipt.entry.config, "opaque"] as OutputField,
              [
                "Данные",
                "Не создавались и не переносились. Доступность проекта проверьте в каталоге.",
              ] as OutputField,
            ]
          : [["Данные", "Файлы проекта сохранены."] as OutputField]),
      ],
      commands: [{ label: "Проверить каталог регистраций", command: readCommand }],
    },
    options,
  );
}

export function groupsText(
  items: readonly { name: string; total: number; completed: number; terminal: number }[],
  options: TextOptions,
): string {
  const progress = (group: (typeof items)[number]) =>
    `${"█".repeat(Math.round((10 * group.completed) / group.total))}${"░".repeat(10 - Math.round((10 * group.completed) / group.total))}`;
  const body =
    options.width < 70
      ? items
          .map((group) =>
            wrap(
              `${safeText(group.name)}\n${progress(group)} ${group.completed}/${group.total} · завершено: ${group.terminal}`,
              options.width,
            ),
          )
          .join("\n\n")
      : table(
          ["ГРУППА", "ПРОГРЕСС", "ВЫПОЛНЕНО", "ЗАВЕРШЕНО"],
          items.map((group) => [
            safeText(group.name),
            progress(group),
            `${group.completed}/${group.total}`,
            String(group.terminal),
          ]),
          [options.width - 38, 10, 10, 12],
          options,
        );
  return section(`Группы · ${items.length}`, items.length ? body : "Групп нет.", options);
}
