import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { initialize } from "@relay/core/storage/workspace";
import { observeDevProcess } from "./dev-process.js";

const execute = promisify(execFile);

for (const configuration of ["default", "relative"] as const)
  test(
    `root dev-сервер (${configuration}) переживает очистку dist и изменения сервера и Core`,
    // Общий cold-start 120 с, две фазы reload по 60 с и 60 с на копию, проверки и остановку.
    { timeout: 300000 },
    async (t) => {
      const project = fileURLToPath(new URL("../../../", import.meta.url));
      const root = await realpath(await mkdtemp(join(tmpdir(), "tasks-dev-server-")));
      let stop: (() => Promise<void>) | undefined;
      t.after(async () => {
        await stop?.();
        await rm(root, { recursive: true, force: true, maxRetries: 5 });
      });
      const workspaces = [
        "apps/cli",
        "apps/server",
        "apps/web",
        "packages/core",
        "packages/contracts",
        "packages/rest-sdk",
        "packages/project-runtime",
        "packages/server-runtime",
        "packages/typescript-config",
      ];
      // Копия изолирует очистку и изменение исходников от работающего dev-сервера разработчика.
      for (const path of ["package.json", "turbo.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"])
        await cp(join(project, path), join(root, path));
      for (const path of workspaces) {
        const destination = join(root, path);
        await mkdir(dirname(destination), { recursive: true });
        await cp(join(project, path), destination, {
          recursive: true,
          filter: (source) =>
            !["dist", "node_modules", ".turbo", ".cache", ".artifacts"].includes(basename(source)),
        });
      }
      // У каждого пакета свои зависимости. Внешние пакеты общие, workspace-ссылки ведут в копию.
      const workspaceTargets = new Map(
        await Promise.all(
          workspaces.map(
            async (path) => [await realpath(join(project, path)), join(root, path)] as const,
          ),
        ),
      );
      for (const path of ["", ...workspaces]) {
        const sourceModules = join(project, path, "node_modules");
        if (!existsSync(sourceModules)) continue;
        const modules = join(root, path, "node_modules");
        await mkdir(modules);
        const link = async (name: string) => {
          const target = await realpath(join(sourceModules, name));
          await symlink(workspaceTargets.get(target) ?? target, join(modules, name), "junction");
        };
        for (const entry of await readdir(sourceModules, { withFileTypes: true })) {
          if (!(entry.isDirectory() || entry.isSymbolicLink())) continue;
          if (entry.name.startsWith("@")) {
            await mkdir(join(modules, entry.name));
            for (const dependency of await readdir(join(sourceModules, entry.name)))
              await link(join(entry.name, dependency));
          } else {
            await link(entry.name);
          }
        }
      }
      const resolution = await execute(
        process.execPath,
        [
          "--conditions=tasks-source",
          "--input-type=module",
          "-e",
          "console.log(JSON.stringify(['@relay/core/storage/workspace', '@relay/contracts', '@relay/server-runtime'].map((name) => import.meta.resolve(name))))",
        ],
        { cwd: join(root, "apps/cli") },
      );
      assert.deepEqual(
        JSON.parse(resolution.stdout),
        [
          "packages/core/src/storage/workspace.ts",
          "packages/contracts/src/index.ts",
          "packages/server-runtime/src/bootstrap.ts",
        ].map((path) => pathToFileURL(join(root, path)).href),
      );
      const workspace = configuration === "default" ? "apps/playground/local" : "custom tasks";
      const initialized = await initialize(join(root, workspace), "tasks");
      if (configuration === "default") {
        await writeFile(
          join(root, "apps/playground/relay.workspace.json"),
          JSON.stringify({ version: 1, mode: "workspace", projects: { local: { path: "local" } } }),
        );
      }
      const apiPrefix =
        configuration === "default"
          ? `/api/v1/projects/${initialized.config.projectId}`
          : "/api/v1";
      const executable = process.env.npm_execpath;
      assert(executable, "Запускайте тест через pnpm run test:server");
      let pnpmCli = await realpath(executable);
      if (!/\.[cm]?js$/.test(pnpmCli)) {
        // CI передаёт .bin-обёртку; Node.js должен запускать JS-файл из манифеста pnpm.
        const manifestPath = createRequire(pnpmCli).resolve("pnpm");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        assert.equal(typeof manifest.bin?.pnpm, "string");
        pnpmCli = resolve(dirname(manifestPath), manifest.bin.pnpm);
      }
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CI: "true",
        GITHUB_ACTIONS: "true",
        RELAY_PORT: "0",
        RELAY_ACTOR: "dev-human",
      };
      delete env.RELAY_CONFIG;
      if (configuration === "relative") env.RELAY_CONFIG = `${workspace}/.relay/config.json`;
      const grouped = process.platform !== "win32";
      const startupStarted = performance.now();
      const startupBudget = 120000;
      // В Actions Turbo буферизует grouped-логи до завершения задачи; ждём URL из живого потока.
      const child = spawn(process.execPath, [pnpmCli, "run", "dev:server", "--log-order=stream"], {
        cwd: root,
        env,
        detached: grouped,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const monitor = observeDevProcess(child);
      const signal = (name: NodeJS.Signals) => {
        try {
          if (grouped && child.pid) process.kill(-child.pid, name);
          else child.kill(name);
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH"))
            throw error;
        }
      };
      stop = async () => {
        if (!monitor.closed) {
          signal("SIGTERM");
          const timer = setTimeout(() => signal("SIGKILL"), 5000);
          try {
            await monitor.completion;
          } finally {
            clearTimeout(timer);
          }
        }
        t.diagnostic(monitor.status());
      };
      const waitFor = monitor.waitFor;
      let phase = "initial";
      const nextServer = async (name: string, outputOffset: number, timeout: number) => {
        phase = name;
        // Старый URL, даже от лишнего предыдущего рестарта, не подтверждает текущую мутацию.
        const urls = () => [
          ...monitor.output.slice(outputOffset).matchAll(/Relay: (http:\/\/127\.0\.0\.1:\d+)/g),
        ];
        await waitFor(
          () => urls().length > 0,
          `${phase}: новый URL не опубликован; запуск или перезапуск не подтверждён`,
          timeout,
        );
        t.diagnostic(`${phase}: новый URL опубликован; ${monitor.status()}`);
        return urls().at(-1)![1]!;
      };
      const json = async (url: string) => {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
          assert.equal(response.status, 200);
          return await response.json();
        } catch (cause) {
          throw new Error(`${phase}: URL опубликован, но REST-проверка ${url} не прошла`, {
            cause,
          });
        }
      };

      // HTTP и tsc работают параллельно: быстрый HTTP не сокращает бюджет компилятора.
      // На hosted CI прежних 30 с после HTTP не хватало даже живому tsc без ошибок.
      // Ограничиваем весь старт от spawn: до 60 с на HTTP, до 120 с на обе готовности.
      let url = await nextServer("initial", 0, 60000);
      const context = (await json(`${url}${apiPrefix}/context`)).data;
      assert.equal(context.actor, "dev-human");
      assert.equal(context.configPath, join(root, workspace, ".relay/config.json"));
      // Первая компиляция может завершиться позже HTTP-запуска на загруженном CI-runner.
      await monitor.waitForTypecheck(
        Math.max(0, Math.ceil(startupBudget - (performance.now() - startupStarted))),
      );
      t.diagnostic(`initial/typecheck: успешная компиляция подтверждена; ${monitor.status()}`);
      const outputs = workspaces
        .filter((path) => path !== "packages/typescript-config")
        .map((path) => join(root, path, "dist"));
      for (const path of outputs) {
        await assert.rejects(access(path), { code: "ENOENT" });
        await mkdir(path);
        await writeFile(join(path, "build-marker"), "production build");
      }
      await execute(process.execPath, [pnpmCli, "--recursive", "--if-present", "run", "clean"], {
        cwd: root,
      });
      for (const path of outputs) await assert.rejects(access(path), { code: "ENOENT" });
      assert.equal((await json(`${url}/api/v1/health`)).data.status, "ok");

      const healthPath = join(root, "packages/server-runtime/src/modules/health/health.module.ts");
      const health = await readFile(healthPath, "utf8");
      assert(health.includes('stage: "ready"'));
      const serverReloadOffset = monitor.output.length;
      await writeFile(healthPath, health.replace('stage: "ready"', 'stage: "scaffold"'));
      url = await nextServer("Server reload", serverReloadOffset, 60000);
      assert.equal(
        (await json(`${url}/api/v1/health`)).data.stage,
        "scaffold",
        "Server reload: новый сервер должен исполнять изменённый health",
      );

      // Статика разрешается от package.json также при запуске исходников через tsx.
      await mkdir(join(root, "apps/server/dist/web"), { recursive: true });
      const html = "<!doctype html><html>Built frontend fixture</html>";
      await writeFile(join(root, "apps/server/dist/web/index.html"), html);
      const corePath = join(root, "packages/core/src/application/board-tasks/service.ts");
      const core = await readFile(corePath, "utf8");
      const createInput = 'parse(createBoardTaskSchema, input, "создание задачи")';
      assert.equal(core.split(createInput).length, 2, "Ожидается одна точка создания задачи");
      const coreReloadOffset = monitor.output.length;
      await writeFile(
        corePath,
        core.replace(
          createInput,
          'parse(createBoardTaskSchema, { ...input, title: "core reload" }, "создание задачи")',
        ),
      );
      url = await nextServer("Core reload", coreReloadOffset, 60000);
      const created = await fetch(`${url}${apiPrefix}/board-tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ board: "product", title: "Исходный Core", requestId: "reload" }),
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(created.status, 200);
      const taskId = (await created.json()).data.id;
      assert.equal(
        (await json(`${url}${apiPrefix}/board-tasks/${taskId}`)).data.title,
        "core reload",
        "Core reload: новый сервер должен исполнять изменённый Core",
      );
      assert.equal(await (await fetch(url, { signal: AbortSignal.timeout(3000) })).text(), html);
      assert.equal((await json(`${url}/api/openapi.json`)).openapi, "3.1.0");
      signal("SIGTERM");
      await waitFor(() => monitor.closed, "Dev-сервер не завершился по SIGTERM", 12000, true);
    },
  );
