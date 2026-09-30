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
  // В CI (`CI` в окружении) Vite и другие утилиты раскрашивают вывод; строки готовности
  // и диагностика должны оставаться простым текстом.
  delete env.FORCE_COLOR;
  return { ...env, NO_COLOR: "1", RELAY_ACTOR: "web-e2e", ...overrides };
};

/** Удаляет ANSI-последовательности, если процесс всё же раскрасил вывод. */
const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

/** Хвост вывода процесса для диагностики. */
const tail = (text, limit = 4_000) =>
  text.length > limit ? `…${text.slice(text.length - limit)}` : text;

/** Предел ожидания готовности процесса; на CI с 2 vCPU запуск занимает секунды. */
const startTimeout = 60_000;

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
 * Создаёт временный workspace из независимых проектов во временном каталоге репозитория.
 * Пользовательские базы и `apps/playground/.relay` не затрагиваются.
 * @param {string[]} keys Ключи регистрации проектов; по умолчанию `alpha` и `beta`.
 */
export async function createWorkspace(keys = ["alpha", "beta"]) {
  const base = join(repositoryRoot, ".artifacts");
  await mkdir(base, { recursive: true });
  const root = await realpath(await mkdtemp(join(base, "web-e2e-")));
  const projects = {};
  for (const key of keys) {
    const directory = join(root, key);
    await mkdir(directory);
    await run(process.execPath, [cliBinary, "init"], { cwd: directory, env: isolatedEnv() });
    projects[key] = { key, directory, config: join(directory, ".relay/config.json") };
  }
  const config = join(root, "relay.workspace.json");
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      projects: Object.fromEntries(keys.map((key) => [key, { path: key }])),
    }),
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

/** Останавливает процесс: SIGTERM, затем SIGKILL через 10 с; ждёт фактического выхода. */
const stopChild = async (child, exit) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await exit;
  clearTimeout(timer);
};

/**
 * Останавливает все ещё живые процессы harness, в том числе не дошедшие до готовности.
 * Вызывается в `after` последним шагом, чтобы `node --test` мог завершиться.
 */
export async function stopAllProcesses() {
  await Promise.all([...children].map(({ child, exit }) => stopChild(child, exit)));
}

/**
 * Запускает процесс и ожидает готовности по stdout.
 * При сбое процесс останавливается, а ошибка содержит команду, код выхода и хвосты вывода.
 * @param {string} name Название шага для диагностики.
 */
const spawnReady = (name, command, args, options, isReady) => {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
  });
  const entry = { child, exit };
  children.add(entry);
  void exit.then(() => children.delete(entry));
  let output = "";
  let errors = "";
  const describe = (reason) =>
    new Error(
      [
        `${name}: ${reason}`,
        `команда: ${[command, ...args].join(" ")}`,
        `cwd: ${options.cwd}`,
        `stdout (хвост):\n${tail(output) || "<пусто>"}`,
        `stderr (хвост):\n${tail(errors) || "<пусто>"}`,
      ].join("\n"),
    );
  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void stopChild(child, exit).then(() => reject(error));
    };
    const timer = setTimeout(
      () => fail(describe(`нет готовности за ${startTimeout / 1000} с`)),
      startTimeout,
    );
    child.stdout.setEncoding("utf8").on("data", (text) => {
      output += stripAnsi(text);
      if (settled) return;
      let value;
      try {
        value = isReady(output);
      } catch (error) {
        fail(describe(`неразборчивая строка готовности: ${error.message}`));
        return;
      }
      if (value !== undefined) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    });
    child.stderr.setEncoding("utf8").on("data", (text) => {
      errors += stripAnsi(text);
    });
    void exit.then(({ code, signal, error }) =>
      fail(
        describe(
          error
            ? `не запустился: ${error.message}`
            : `завершился до готовности (код ${code}, сигнал ${signal})`,
        ),
      ),
    );
  });
  return {
    child,
    ready,
    /** Текущие хвосты вывода для диагностики упавшего теста. */
    logs: () => `stdout:\n${tail(output)}\nstderr:\n${tail(errors)}`,
    stop: () => stopChild(child, exit),
  };
};

/**
 * Запускает собственный Relay Server на заданном порту для временного workspace.
 * @param {{config: string, cwd: string, port: number, webPort: number}} options
 */
export async function startRelayServer({ config, cwd, port, webPort }) {
  const processHandle = spawnReady(
    "Relay Server",
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
  return { url, stop: processHandle.stop, logs: processHandle.logs };
}

/**
 * Запускает Vite текущих исходников Web; `/api` проксируется на управляемый прокси.
 * @param {{port: number, apiUrl: string}} options
 */
export async function startWeb({ port, apiUrl }) {
  const processHandle = spawnReady(
    "Vite",
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
  try {
    await until(async () => (await fetch(url)).ok, { message: "Vite отвечает" });
  } catch (error) {
    await processHandle.stop();
    throw new Error(`${error.message}\n${processHandle.logs()}`);
  }
  return { url, stop: processHandle.stop, logs: processHandle.logs };
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
