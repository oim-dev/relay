import type { Command } from "commander";
import { Option } from "commander";
import type { ServerContextResponse } from "@relay/contracts";
import { initializeRegistry } from "@relay/project-runtime/registry";
import { createServerApi } from "@relay/project-runtime/backend/server";
import { invariant } from "@relay/core/shared/errors";
import type { GlobalOptions, Runtime } from "../context.js";
import { outputOptions } from "../context.js";
import { commandGroup, createCommand } from "../command.js";
import { printResult } from "../output.js";
import { paging, offsetQueryFor, pageResultFor } from "../command-kit.js";
import type { PaginationContext } from "../command-kit.js";
import {
  registryProjectsText,
  registrySavedText,
  registryCompactSavedText,
} from "../presentation/project.js";
import { workspaceConnection } from "./workspace-connection.js";

function projection(command: Command) {
  return command.addOption(
    new Option(
      "--projection <mode>",
      "Ответ: compact — только изменённая регистрация (по умолчанию в тексте), full — полный каталог",
    ).choices(["full", "compact"]),
  );
}

export function registerProjects(program: Command, runtime: Runtime) {
  const workspace = commandGroup(program, {
    name: "workspace",
    description: "Подключения нескольких независимых проектов",
    details: "Управление реестром, не данными выбранного проекта.",
    examples: [["npx @oim-dev/relay-cli workspace project list", "Посмотреть регистрации"]],
  });
  const group = commandGroup(workspace, {
    name: "project",
    description: "Проекты Relay workspace",
    details:
      "Пути относятся к файловой системе Server и разрешаются относительно его relay.workspace.json. --server-url или RELAY_SERVER_URL позволяют работать без локального реестра.",
    examples: [
      ["npx @oim-dev/relay-cli workspace project init", "Создать пустой workspace"],
      [
        "npx @oim-dev/relay-cli workspace project add backend ../backend",
        "Зарегистрировать инициализированный проект",
      ],
    ],
  });
  for (const operation of ["init", "list", "add", "remove"] as const) {
    const command = createCommand(group, {
      name:
        operation === "add"
          ? "add <name> [path]"
          : operation === "remove"
            ? "remove <name>"
            : operation,
      description: {
        init: "Создать конфиг проектов",
        list: "Показать зарегистрированные проекты",
        add: "Зарегистрировать или обновить проект",
        remove: "Удалить регистрацию проекта, сохранив его данные",
      }[operation],
      ...(operation === "add"
        ? {
            arguments: {
              name: "Имя проекта в workspace",
              path: "Путь проекта относительно workspace-конфига",
            },
          }
        : operation === "remove"
          ? { arguments: { name: "Имя удаляемой регистрации проекта" } }
          : {}),
      details:
        operation === "list"
          ? "--server-url, RELAY_SERVER_URL или конфиг задают подключение без выбора проекта. Поддерживаются workspace и local Server с relay-project-catalog-v1. По сети передаётся только страница, Server проверяет отпечаток полного каталога. При изменении начните заново; исторического снимка нет. Старый Server требует обновления, скрытого полного чтения нет."
          : operation === "add"
            ? "Подключение: --server-url, RELAY_SERVER_URL или конфиг. Пути относятся к Server: path — относительно серверного реестра, --project-config — относительно path (без path — реестра). --replace явно разрешает замену. Данные не создаются и не переносятся. По умолчанию текст показывает краткую квитанцию compact, требующую relay-project-catalog-v1; --projection full явно выбирает полный каталог."
            : operation === "remove"
              ? "Удаляется только регистрация, данные проекта сохраняются. Подключение: --server-url, RELAY_SERVER_URL или конфиг. Требуется workspace Server. По умолчанию текст показывает краткую квитанцию compact с relay-project-catalog-v1; --projection full явно выбирает полный каталог."
              : "Создаёт локальный пустой relay.workspace.json. --config задаёт путь реестра. Проектный префикс и --project недопустимы.",
      examples: [
        [
          `npx @oim-dev/relay-cli workspace project ${operation}${operation === "add" ? " backend ../backend" : operation === "remove" ? " backend" : ""}`,
          "Управление реестром",
        ],
      ],
      ...(operation === "add"
        ? {
            configure: (target: Command) =>
              projection(target)
                .option("--project-config <path>", "Конфиг относительно каталога проекта")
                .option("--replace", "Заменить существующее подключение"),
          }
        : operation === "list"
          ? { configure: paging }
          : operation === "remove"
            ? { configure: projection }
            : {}),
    });
    command.action(async () => {
      const globals = command.optsWithGlobals<GlobalOptions>();
      invariant(
        !globals.project,
        "INVALID_ARGUMENT",
        "Команды workspace project относятся ко всему реестру; уберите --project и проектный префикс",
      );
      runtime.output = outputOptions(runtime, globals);
      if (operation === "init") {
        const data = await initializeRegistry(
          runtime.cwd,
          globals.config ?? runtime.env.RELAY_CONFIG,
        );
        printResult(
          runtime.stdout,
          {
            data,
            text: (options) => registrySavedText({ operation: "init", data }, options),
          },
          runtime.output,
        );
        return;
      }
      const connection = await workspaceConnection(runtime, globals);
      const { endpoint, configPath } = connection;
      const api = createServerApi(endpoint);
      let data: ServerContextResponse;
      if (operation === "list") {
        const controls = command.opts<{ limit?: number; cursor?: string }>();
        const pagination: PaginationContext = {
          identity: { kind: "registry", config: configPath, endpoint: new URL(endpoint).href },
          defaultLimit: 20,
          invocation: connection.invocation,
        };
        const path = ["workspace", "project", "list"];
        const filters = {};
        const query = offsetQueryFor(pagination, controls, path, filters);
        invariant(
          Object.keys(filters).length === 0,
          "INVALID_CURSOR",
          "Каталог проектов не поддерживает фильтры курсора. Начните список заново без --cursor",
        );
        const result = (await api.projects.getProjectCatalogPage(query)).data;
        const { catalog } = result;
        const page = pageResultFor(pagination, path, filters, query, {
          items: catalog.projects,
          total: result.total,
          nextOffset: result.nextOffset,
          version: result.version,
        });
        printResult(
          runtime.stdout,
          {
            data: catalog,
            meta: {
              ...(configPath ? { configPath } : {}),
              paginationSource: "server-catalog-fingerprint",
            },
            page,
            text: (options) => registryProjectsText(catalog, options, connection),
          },
          runtime.output,
        );
        return;
      }
      const options = command.opts<{
        projectConfig?: string;
        replace?: boolean;
        projection?: "compact" | "full";
      }>();
      const project = { project: encodeURIComponent(command.args[0]!) };
      const entry = {
        ...(command.args[1] === undefined ? {} : { path: command.args[1] }),
        ...(options.projectConfig === undefined ? {} : { config: options.projectConfig }),
        ...(options.replace === undefined ? {} : { replace: options.replace }),
      };
      const compact =
        options.projection === "compact" ||
        (options.projection === undefined && runtime.output.format === "text");
      if (compact) {
        const receipt =
          operation === "remove"
            ? (await api.projects.unregisterProjectCompact(project)).data
            : (await api.projects.registerProjectCompact(project, entry)).data;
        printResult(
          runtime.stdout,
          {
            data: receipt,
            ...(configPath ? { meta: { configPath } } : {}),
            text: (text) =>
              registryCompactSavedText(
                receipt,
                text,
                connection.command(["workspace", "project", "list"]),
              ),
          },
          runtime.output,
        );
        return;
      }
      if (operation === "remove") data = (await api.projects.unregisterProject(project)).data;
      else {
        data = (await api.projects.registerProject(project, entry)).data;
      }
      printResult(
        runtime.stdout,
        {
          data,
          ...(configPath ? { meta: { configPath } } : {}),
          text: (options) =>
            registrySavedText(
              { operation, data, name: command.args[0]! },
              options,
              connection.command(["workspace", "project", "list"]),
            ),
        },
        runtime.output,
      );
    });
  }
}
