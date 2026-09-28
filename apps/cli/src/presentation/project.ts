import type { Config } from "@relay/core/domain/config";
import type { RelayProject, ServerContextResponse } from "@relay/contracts";
import type { EntityDetail, EntitySaved } from "@relay/contracts/entities";
import { defaultTextOptions, type TextOptions } from "./theme.js";
import { safeText } from "./safe.js";
import { section, table, wrap } from "./layout.js";
import { cardText, listText, receiptText, type OutputField } from "./common.js";
import { shellCommand } from "../command-kit.js";

export function initializedText(
  configPath: string,
  storageDir: string,
  options: TextOptions,
): string {
  return receiptText(
    {
      title: "✓ Проект инициализирован",
      fields: [
        ["Конфигурация", configPath],
        ["Хранилище", storageDir],
      ],
      commands: [
        {
          label: "Следующий шаг: подготовить паспорт продукта",
          command: shellCommand([
            "npx",
            "@oim-dev/relay-cli",
            "--local",
            "--config",
            configPath,
            "product",
            "create",
            "--help",
          ]),
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
  connection?: string,
  readCommand?: string,
): string {
  return cardText(
    {
      title: `Конфигурация — ${config.projectSettings?.entityKey ?? "PROJECT"} — ${config.projectSettings?.name ?? "проект"}`,
      fields: [
        ["Ревизия проекта", config.projectSettings?.revision],
        ["Slug", config.projectSettings?.slug],
        ["ID проекта", config.projectId],
        ["Версия конфигурации", config.version],
      ],
      sections: [
        {
          title: "Подключение и пути",
          body: cardText(
            {
              title: "",
              fields: [
                ["Текущий доступ", connection],
                ["Конфигурация", configPath],
                ["Хранилище", root],
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

export function projectText(
  entity: EntityDetail,
  options: TextOptions,
  updateHelp?: string,
): string {
  const project = entity.data;
  if (project.kind !== "project") return "Ответ не является проектом.";
  return cardText(
    {
      title: `${entity.key} — ${project.name}`,
      fields: [
        ["Ревизия", entity.revision],
        ["Slug", project.slug],
        ["ID проекта", entity.ref.id],
      ],
      sections: [
        {
          title: "Разделы документов",
          body:
            project.documentSections === undefined
              ? "Разделы явно не заданы; используются стандартные разделы библиотеки."
              : listText(
                  {
                    title: "",
                    items: project.documentSections.map((item) => ({
                      key: item.id,
                      title: item.name,
                    })),
                    emptyMessage: "Разделов нет.",
                  },
                  options,
                ),
        },
      ],
      commands: updateHelp
        ? [{ label: "Изменить имя по прочитанной ревизии: справка", command: updateHelp }]
        : [],
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
  items: readonly RelayProject[],
  options: TextOptions,
  connection?: { configPath: string; endpoint: string },
): string {
  return listText(
    {
      title: "Проекты workspace",
      filters: connection
        ? [
            ["Реестр", connection.configPath],
            ["Сервер", connection.endpoint],
          ]
        : [],
      items: items.map((item) => ({
        key: item.key,
        title: item.name,
        details: [
          `Состояние: ${item.available ? "доступен" : "недоступен"}`,
          `Конфигурация: ${item.configPath}`,
          ...(item.error ? [`Причина: ${item.error}`] : []),
          ...(item.slug ? [`Slug: ${item.slug}`] : []),
          `ID${item.available ? "" : " регистрации (база не подтверждена)"}: ${item.id}`,
        ],
      })),
      emptyMessage: "Регистраций на этой странице нет.",
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
          [
            "Следующий шаг",
            "Запустите Relay Server с этим реестром, затем подключите существующий проект через workspace project add.",
          ],
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
