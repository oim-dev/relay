import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Корень репозитория и собранные исполняемые файлы, которые проверяет harness. */
export const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const webRoot = join(repositoryRoot, "apps/web");
const serverBinary = join(repositoryRoot, "apps/server/dist/main.js");
const cliBinary = join(repositoryRoot, "apps/cli/dist/cli/main.js");
const viteBinary = join(webRoot, "node_modules/vite/bin/vite.js");

/** Окружение без подключения к пользовательской базе и серверу. */
const isolatedEnv = (overrides = {}) => {
  const env = { ...process.env };
  for (const key of ["RELAY_CONFIG", "RELAY_SERVER_URL", "RELAY_PORT", "RELAY_API_URL", "INIT_CWD"])
    delete env[key];
  return { ...env, RELAY_ACTOR: "web-e2e", ...overrides };
};

/** Проверяет наличие сборок Server и CLI, без которых harness не запускается. */
export async function assertBuilt() {
  for (const path of [serverBinary, cliBinary, viteBinary]) {
    try {
      await access(path);
    } catch {
      throw new Error(
        `Нет сборки ${relative(repositoryRoot, path)}. Выполните: pnpm exec turbo run build --filter=@oim-dev/relay-server --filter=@oim-dev/relay-cli`,
      );
    }
  }
}

/** Выдаёт свободный локальный порт. */
export async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string") throw new Error("Порт не выделен");
  return address.port;
}

/** Ожидает истинное значение с дедлайном; для процессов и сети, не для браузера. */
export async function until(check, { timeout = 20_000, interval = 50, message = "условие" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Не дождались: ${message}; последнее значение: ${String(last)}`);
}

/**
 * Создаёт временный workspace из двух независимых проектов во временном каталоге репозитория.
 * Пользовательские базы и `apps/playground/.relay` не затрагиваются.
 */
export async function createWorkspace() {
  const base = join(repositoryRoot, ".artifacts");
  await mkdir(base, { recursive: true });
  const root = await realpath(await mkdtemp(join(base, "web-e2e-")));
  const projects = {};
  for (const key of ["alpha", "beta"]) {
    const directory = join(root, key);
    await mkdir(directory);
    await run(process.execPath, [cliBinary, "init"], { cwd: directory, env: isolatedEnv() });
    projects[key] = { key, directory, config: join(directory, ".relay/config.json") };
  }
  const config = join(root, "relay.workspace.json");
  await writeFile(
    config,
    JSON.stringify({ version: 1, projects: { alpha: { path: "alpha" }, beta: { path: "beta" } } }),
  );
  return {
    root,
    config,
    projects,
    async remove() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Снимок содержимого базы для проверки отсутствия записи при чтении обзора. */
export async function fingerprint(directory) {
  const hash = createHash("sha256");
  const walk = async (path) => {
    const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const child = join(path, entry.name);
      // Служебные блокировки и runtime-состояние процесса не являются данными проекта.
      if (entry.name === "runtime" || entry.name.endsWith(".lock")) continue;
      if (entry.isDirectory()) await walk(child);
      else {
        hash.update(relative(directory, child));
        hash.update(await readFile(child));
        hash.update(String((await stat(child)).size));
      }
    }
  };
  await walk(directory);
  return hash.digest("hex");
}

/** Все запущенные harness процессы; завершаются и при аварийном выходе теста. */
const children = new Set();
process.once("exit", () => {
  for (const child of children) child.kill("SIGKILL");
});

/** Запускает процесс и ожидает строку готовности в stdout. */
const spawnReady = (command, args, options, isReady) => {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  child.once("exit", () => children.delete(child));
  let output = "";
  let errors = "";
  const exit = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Процесс не запустился\n${output}\n${errors}`)),
      60_000,
    );
    child.stdout.setEncoding("utf8").on("data", (text) => {
      output += text;
      const value = isReady(output);
      if (value !== undefined) {
        clearTimeout(timer);
        resolve(value);
      }
    });
    child.stderr.setEncoding("utf8").on("data", (text) => {
      errors += text;
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Процесс завершился до готовности\n${output}\n${errors}`));
    });
  });
  return {
    child,
    ready,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exit;
      clearTimeout(timer);
    },
  };
};

/**
 * Запускает собственный Relay Server на заданном порту для временного workspace.
 * @param {{config: string, cwd: string, port: number, webPort: number}} options
 */
export async function startRelayServer({ config, cwd, port, webPort }) {
  const processHandle = spawnReady(
    process.execPath,
    [serverBinary, "--config", config, "--port", String(port), "--format", "json"],
    { cwd, env: isolatedEnv({ RELAY_WEB_PORT: String(webPort) }) },
    (output) => {
      const line = output.split("\n")[0];
      if (!output.includes("\n")) return undefined;
      return JSON.parse(line).data.url;
    },
  );
  const url = await processHandle.ready;
  return { url, stop: processHandle.stop };
}

/**
 * Запускает Vite текущих исходников Web; `/api` проксируется на управляемый прокси.
 * @param {{port: number, apiUrl: string}} options
 */
export async function startWeb({ port, apiUrl }) {
  const processHandle = spawnReady(
    process.execPath,
    [
      viteBinary,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
      "--clearScreen",
      "false",
    ],
    { cwd: webRoot, env: isolatedEnv({ RELAY_API_URL: apiUrl, RELAY_WEB_PORT: String(port) }) },
    (output) => (output.includes(`127.0.0.1:${port}`) ? true : undefined),
  );
  await processHandle.ready;
  const url = `http://127.0.0.1:${port}`;
  await until(async () => (await fetch(url)).ok, { message: "Vite отвечает" });
  return { url, stop: processHandle.stop };
}

/** Клиент REST собственного сервера для подготовки и изменения данных проекта. */
export function relayApi(serverUrl, projectId) {
  let sequence = 0;
  const call = async (method, path, body) => {
    const response = await fetch(
      `${serverUrl()}/api/v1/projects/${encodeURIComponent(projectId)}${path}`,
      {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    const json = await response.json();
    if (!json.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json.error)}`);
    return json.data;
  };
  const requestId = () => `web-e2e-${Date.now()}-${(sequence += 1)}`;
  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, { requestId: requestId(), ...body }),
    put: (path, body) => call("PUT", path, body),
  };
}

/** Выполняет собранный CLI напрямую с базой проекта, минуя сервер. */
export async function runLocalCli(projectConfig, args) {
  const { stdout } = await run(
    process.execPath,
    [cliBinary, ...args, "--config", projectConfig, "--local", "--format", "json"],
    { env: isolatedEnv() },
  );
  const result = JSON.parse(stdout);
  if (!result.ok) throw new Error(`CLI ${args.join(" ")}: ${stdout}`);
  return result.data;
}
