import { access, lstat, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function json(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024)
    throw new Error("Ожидается обычный JSON-файл не более 1 МиБ");
  return JSON.parse(await readFile(path, "utf8"));
}

async function commandAvailable(name, env) {
  const extensions = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try {
        await access(
          join(directory, name + extension),
          process.platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        return true;
      } catch {
        /* Проверяем следующий каталог PATH, ничего не исполняем. */
      }
    }
  }
  return false;
}

function origin(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Адрес Server должен быть HTTP(S) origin без credentials, пути и query");
  return url.origin;
}

async function request(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2500), redirect: "error" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("Ответ диагностики превышает 1 МиБ");
  const result = JSON.parse(text);
  if (result.ok !== true || !result.data) throw new Error("Ответ не соответствует Relay");
  return result.data;
}

/** Только наблюдения: без npm-загрузок, открытия Core, запуска процессов и записи файлов. */
export async function diagnose(options, env = process.env) {
  const root = await realpath(options.root);
  if (!(await lstat(root)).isDirectory()) throw new Error("Корень проекта должен быть каталогом");
  const report = {
    schemaVersion: 1,
    root,
    runtime: {
      node: process.versions.node,
      supported: Number(process.versions.node.split(".")[0]) >= 22,
      npx: await commandAvailable("npx", env),
    },
    configuration: { state: "missing" },
    server: { state: "not-checked" },
    client: { selected: options.client ?? null, files: [], session: "agent-must-call-mcp" },
    next: [],
  };
  let configPath = options.config ?? env.RELAY_CONFIG;
  let selectedBy = options.config ? "argument" : env.RELAY_CONFIG ? "environment" : "search";
  if (configPath) configPath = resolve(root, configPath);
  else {
    for (let directory = root; ; directory = dirname(directory)) {
      for (const candidate of [
        join(directory, "relay.workspace.json"),
        join(directory, ".relay/config.json"),
      ]) {
        if (await exists(candidate)) {
          configPath = candidate;
          break;
        }
      }
      if (configPath || dirname(directory) === directory) break;
    }
  }
  let config;
  let expectedId;
  if (configPath) {
    try {
      config = await json(configPath);
      if (!config || typeof config !== "object" || config.version !== 1)
        throw new Error("Неизвестная версия или форма конфигурации");
      const mode = config.mode ?? (config.projects ? "workspace" : "local");
      if (!["local", "workspace"].includes(mode)) throw new Error("Неизвестный режим");
      report.configuration = {
        state: "found",
        path: configPath,
        selectedBy,
        mode,
        validation: "structural-only",
      };
      if (mode === "local") {
        expectedId = config.projectId;
        report.configuration.storageMarker = await exists(
          join(dirname(configPath), "storage.json"),
        );
        if (!report.configuration.storageMarker)
          report.next.push("inspect-storage-format-before-any-init");
      } else {
        if (
          !config.projects ||
          typeof config.projects !== "object" ||
          Array.isArray(config.projects)
        )
          throw new Error("Некорректный реестр проектов");
        report.configuration.projects = Object.keys(config.projects);
        if (!options.project) report.next.push("select-workspace-project");
        else {
          const registration = config.projects[options.project];
          if (!registration) throw new Error("Выбранная регистрация отсутствует в конфиге");
          const base = resolve(dirname(configPath), registration.path ?? ".");
          const localPath = resolve(base, registration.config ?? ".relay/config.json");
          expectedId = (await json(localPath)).projectId;
          report.configuration.projectConfig = localPath;
        }
      }
    } catch (error) {
      report.configuration = { state: "invalid", path: configPath, reason: error.message };
      report.next.push("inspect-config-do-not-initialize");
    }
  } else {
    report.configuration.partialDirectory = await exists(join(root, ".relay"));
    report.next.push(
      report.configuration.partialDirectory
        ? "inspect-existing-relay-directory"
        : options.serverUrl || env.RELAY_SERVER_URL
          ? "confirm-remote-project-before-local-setup"
          : "offer-setup-before-writing",
    );
  }
  const clientPaths = {
    "claude-code": [".mcp.json"],
    codex: [".codex/config.toml"],
    opencode: [
      "opencode.json",
      "opencode.jsonc",
      ".opencode/opencode.json",
      ".opencode/opencode.jsonc",
    ],
  };
  if (options.client && !clientPaths[options.client])
    throw new Error("Клиент: claude-code, codex или opencode");
  for (const [client, paths] of Object.entries(clientPaths)) {
    if (options.client && options.client !== client) continue;
    for (const path of paths) {
      if (!(await exists(join(root, path)))) continue;
      const item = { client, path, state: "present-needs-client-validation" };
      if (path.endsWith(".json")) {
        try {
          const value = await json(join(root, path));
          const entry = client === "opencode" ? value.mcp?.relay : value.mcpServers?.relay;
          item.state = entry ? "relay-entry-present-not-connected" : "relay-entry-not-found";
        } catch {
          item.state = "unparsed-needs-client-validation";
        }
      }
      report.client.files.push(item);
    }
  }
  if (!options.client) report.next.push("confirm-client-from-session-or-user");
  report.next.push("verify-project-config-and-mcp-in-current-session");
  if (report.configuration.state === "invalid") return report;
  const address =
    options.serverUrl ??
    env.RELAY_SERVER_URL ??
    config?.server?.url ??
    (config ? `http://127.0.0.1:${config.server?.port ?? 4700}` : undefined);
  if (address && !options.offline) {
    let url;
    try {
      url = origin(address);
      if (new URL(url).port === "0")
        throw new Error("Нужен фактический адрес Server вместо порта 0");
      await request(`${url}/api/v1/health`);
      const server = await request(`${url}/api/v1/server`);
      if (!["local", "workspace"].includes(server.mode) || !Array.isArray(server.projects))
        throw new Error("Неизвестный контекст Server");
      const selected = server.projects.find((item) =>
        options.project
          ? item.key === options.project || item.id === options.project
          : item.id === server.defaultProject,
      );
      report.server = { state: "reachable", url, mode: server.mode, identity: "unverified" };
      if (!selected) report.next.push("select-server-project");
      else if (selected.available === false) {
        report.server.state = "project-unavailable";
      } else {
        const context = await request(
          `${url}/api/v1/projects/${encodeURIComponent(selected.id)}/context`,
        );
        report.server.projectId = context.projectId;
        report.server.identity = expectedId
          ? context.projectId === expectedId
            ? "matched"
            : "mismatch"
          : "unverified";
        if (report.server.identity !== "matched")
          report.next.push("confirm-project-identity-before-writing");
      }
    } catch (error) {
      report.server = {
        state: "unavailable-or-invalid",
        ...(url ? { url } : {}),
        reason:
          error.name === "TimeoutError"
            ? "timeout"
            : "Не удалось подтвердить Relay API; проверьте адрес, процесс и ответ",
      };
      report.next.push("inspect-server-do-not-change-database");
    }
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: {
        root: { type: "string" },
        config: { type: "string" },
        project: { type: "string" },
        client: { type: "string" },
        "server-url": { type: "string" },
        offline: { type: "boolean" },
      },
    });
    if (!values.root) throw new Error("Укажите --root <каталог сопровождаемого проекта>");
    console.log(
      JSON.stringify(await diagnose({ ...values, serverUrl: values["server-url"] }), null, 2),
    );
  } catch (error) {
    console.log(JSON.stringify({ schemaVersion: 1, error: { message: error.message } }));
    process.exitCode = 1;
  }
}
