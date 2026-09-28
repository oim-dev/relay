import type { Command } from "commander";
import type { ServerContextResponse } from "@relay/contracts";
import { serverAddress } from "@relay/project-runtime/config";
import { initializeRegistry } from "@relay/project-runtime/registry";
import { createServerApi } from "@relay/project-runtime/backend/server";
import { invariant } from "@relay/core/shared/errors";
import type { GlobalOptions, Runtime } from "../context.js";
import { outputOptions } from "../context.js";
import { cliConfiguration } from "../configuration.js";
import { commandGroup, createCommand } from "../command.js";
import { printResult } from "../output.js";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { paging, offsetQueryFor, pageResultFor, shellCommand } from "../command-kit.js";
import type { PaginationContext } from "../command-kit.js";
import { registryProjectsText, registrySavedText } from "../presentation/project.js";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

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
      "Пути разрешаются относительно relay.workspace.json. Регистрациями управляет запущенный Relay Server.",
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
          ? "--config выбирает workspace. Каталог целиком читается с сервера, затем CLI выдаёт страницу. Курсор привязан к отпечатку каталога: при изменении начните заново. Это локальная проверка неизменности ответа, не серверный snapshot."
          : operation === "add"
            ? "--config выбирает workspace. --project-config — конфиг относительно path. --replace явно разрешает заменить регистрацию. Данные проекта не создаются и не переносятся."
            : operation === "remove"
              ? "Удаляется только регистрация, данные проекта сохраняются. --config выбирает workspace."
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
              target
                .option("--project-config <path>", "Конфиг относительно каталога проекта")
                .option("--replace", "Заменить существующее подключение"),
          }
        : operation === "list"
          ? { configure: paging }
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
      const source = await cliConfiguration(runtime, globals, true);
      invariant(source.kind === "registry", "REGISTRY_REQUIRED", "Требуется конфиг проектов");
      invariant(
        !globals.local,
        "WORKSPACE_REQUIRES_SERVER",
        "Проекты workspace управляются через Relay Server",
      );
      const url = globals.serverUrl ?? runtime.env.RELAY_SERVER_URL ?? serverAddress(source);
      const api = createServerApi(url);
      const endpoint = new URL(url).href;
      const configPath = resolve(runtime.cwd, source.path);
      let data: ServerContextResponse;
      if (operation === "list") {
        const controls = command.opts<{ limit?: number; cursor?: string }>();
        const pagination: PaginationContext = {
          identity: { kind: "registry", config: configPath, endpoint },
          defaultLimit: 20,
          invocation: [
            "npx",
            "@oim-dev/relay-cli",
            "--config",
            configPath,
            "--server-url",
            endpoint,
            ...(globals.format ? ["--format", globals.format] : []),
          ],
        };
        const path = ["workspace", "project", "list"];
        const filters = {};
        const query = offsetQueryFor(pagination, controls, path, filters);
        const catalog = (await api.projects.getProjects()).data;
        const items = catalog.projects;
        const selected = items.slice(query.offset, query.offset + query.limit);
        const page = pageResultFor(pagination, path, filters, query, {
          items: selected,
          total: items.length,
          nextOffset: query.offset + query.limit < items.length ? query.offset + query.limit : null,
          version: hash(catalog),
        });
        printResult(
          runtime.stdout,
          {
            data: { ...catalog, projects: selected },
            meta: { configPath: source.path, paginationSource: "client-catalog-fingerprint" },
            page,
            text: (options) => registryProjectsText(selected, options, { configPath, endpoint }),
          },
          runtime.output,
        );
        return;
      } else if (operation === "remove")
        data = (
          await api.projects.unregisterProject({ project: encodeURIComponent(command.args[0]!) })
        ).data;
      else {
        const options = command.opts<{ projectConfig?: string; replace?: boolean }>();
        data = (
          await api.projects.registerProject(
            { project: encodeURIComponent(command.args[0]!) },
            {
              ...(command.args[1] === undefined ? {} : { path: command.args[1] }),
              ...(options.projectConfig === undefined ? {} : { config: options.projectConfig }),
              ...(options.replace === undefined ? {} : { replace: options.replace }),
            },
          )
        ).data;
      }
      printResult(
        runtime.stdout,
        {
          data,
          meta: { configPath: source.path },
          text: (options) =>
            registrySavedText(
              { operation, data, name: command.args[0]! },
              options,
              shellCommand([
                "npx",
                "@oim-dev/relay-cli",
                "--config",
                configPath,
                "--server-url",
                endpoint,
                "workspace",
                "project",
                "list",
              ]),
            ),
        },
        runtime.output,
      );
    });
  }
}
