import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { initialize } from "@relay/core/storage/workspace";
import { EntityEngine } from "@relay/core/application/entities/service";
import { WorkHistoryService } from "@relay/core/application/work-history/service";
import { captureSnapshot } from "@relay/core/application/storage/snapshot";
import { gitMetadataDirectory } from "@relay/core/storage/access";
import { exists } from "@relay/core/storage/files";
import { git, gitText } from "@relay/project-runtime/git-storage/git";
import { commitSnapshot } from "@relay/project-runtime/git-storage/snapshots";
import type { initializeFromTemplate } from "@relay/project-runtime/git-storage/bootstrap";
import type { EntityDetail } from "@relay/contracts/entities";
import {
  invoke,
  invokeRaw,
  successful,
  failed,
  tempDirectory,
  fixtureCleanup,
} from "./helpers/cli.js";
import { httpServer } from "./helpers/http.js";

type Installed = Awaited<ReturnType<typeof initializeFromTemplate>>;

test("init --template: собранный CLI, полная история, text/JSON, doctor и два проекта workspace", async (t) => {
  const root = await tempDirectory(t),
    source = join(root, "source"),
    home = join(root, "home");
  await mkdir(source);
  await git(source, ["init"]);
  const workspace = await initialize(root, "tasks", join(root, "template-data/config.json"));
  const body = "# Полный текст\r\n\n  Пробелы  \n";
  const document = await new EntityEngine(workspace).create(
    {
      requestId: "document",
      data: {
        kind: "document",
        name: "Документ шаблона",
        summary: "Описание",
        documentKind: "rules",
        body,
        relations: [
          {
            type: "documents",
            target: { kind: "project", id: workspace.config.projectId! },
            description: "Материал проекта",
          },
        ],
      },
    },
    "author",
  );
  const history = await new WorkHistoryService(workspace).start(
    { title: "История шаблона", description: body, requestId: "history" },
    "agent",
  );
  const sha = await commitSnapshot(source, (await captureSnapshot(workspace)).files, []);
  await git(source, ["update-ref", "refs/heads/relay-data", sha]);
  const options = { subprocess: true, env: { RELAY_HOME: home } };
  const installed: Installed[] = [];
  for (const slug of ["alpha", "beta"]) {
    const code = join(root, slug);
    await mkdir(code);
    await git(code, ["init", "--initial-branch", "dev"]);
    const data = successful(
      await invoke<Installed>(
        code,
        ["init", "--template", source, "--name-file", "-", "--slug", slug],
        { ...options, input: `Проект ${slug}` },
      ),
    ).data;
    installed.push(data);
    assert.equal(data.template.commit, sha);
    assert.equal(data.validation.valid, true);
    assert.equal(data.synchronization.status, "local");
    assert.equal(data.name, `Проект ${slug}`);
    const gitDir = await gitMetadataDirectory(data.storageDir);
    fixtureCleanup(t, async () => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (
          !(await exists(join(gitDir, "relay-worker/write.lock"))) &&
          !(await exists(join(gitDir, "relay-worker-start.json")))
        )
          return;
        await delay(50);
      }
      assert.fail("Worker тестовой базы не завершился");
    });
    const doc = successful(
      await invoke<EntityDetail>(code, ["document", "get", document.key], options),
    ).data;
    assert.equal(doc.data.kind === "document" && doc.data.body, body);
    assert.equal(doc.references[0]?.ref.id, data.projectId);
    const doctor = await invokeRaw(code, ["doctor", "check"], options);
    assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
    const sessions = await invokeRaw(code, ["session", "get", history.session.id], options);
    assert.equal(sessions.code, 0, sessions.stdout);
    assert.match(sessions.stdout, /История шаблона/);
    failed(await invoke(code, ["init", "--template", source], options), "ALREADY_INITIALIZED", 4);
  }
  assert.notEqual(installed[0]!.projectId, installed[1]!.projectId);
  const registry = join(root, "registry");
  await mkdir(registry);
  await writeFile(
    join(registry, "relay.workspace.json"),
    JSON.stringify({
      version: 1,
      projects: {
        alpha: { config: installed[0]!.configPath },
        beta: { config: installed[1]!.configPath },
      },
    }),
  );
  const server = await httpServer(t, registry);
  for (const data of installed) {
    const result = successful(
      await invoke<EntityDetail>(
        registry,
        ["--server-url", server.url, "--project", data.projectId, "project", "get"],
        options,
      ),
    ).data;
    assert.equal(result.ref.id, data.projectId);
    assert.equal(result.title, data.name);
  }
  const humanCode = join(root, "human");
  await mkdir(humanCode);
  await git(humanCode, ["init"]);
  const human = await invokeRaw(
    humanCode,
    ["init", "--template", source, "--template-ref", sha, "--name", "Человек", "--slug", "human"],
    { ...options, env: { ...options.env, COLUMNS: "40" } },
  );
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /Проект создан из шаблона/);
  assert(human.stdout.includes(sha));
  assert.match(human.stdout, /ID проекта/);
  assert.match(human.stdout, /Целостность/);
  assert.doesNotMatch(human.stdout, /\u001b\[/);
  assert.equal(await gitText(source, ["rev-parse", "relay-data"]), sha);
});

test("init --template: ввод и несовместимые параметры отклоняются до установки", async (t) => {
  const root = await tempDirectory(t);
  const options = { subprocess: true, env: { RELAY_HOME: join(root, "home") } };
  for (const args of [
    ["--template-ref", "relay-data"],
    ["--name", "Название"],
    ["--slug", "slug"],
    ["--template", "missing", "--config", "new.json"],
    ["--template", "missing", "--storage", "tasks"],
    ["--template", "missing", "--name", "Имя", "--name-file", "-"],
  ])
    failed(await invoke(root, ["init", ...args], options), "CONFLICTING_OPTIONS");
  failed(
    await invoke(root, ["init", "--template", "missing"], options),
    "TEMPLATE_GIT_REQUIRED",
    4,
  );
  await git(root, ["init"]);
  const head = await readFile(join(root, ".git/HEAD"));
  failed(
    await invoke(root, ["init", "--template", "missing", "--slug", "BAD"], options),
    "VALIDATION_ERROR",
  );
  failed(
    await invoke(
      root,
      ["init", "--template", "missing", "--server-url", "http://127.0.0.1:1"],
      options,
    ),
    "LOCAL_ONLY",
  );
  assert.equal(await exists(join(root, "home")), false);
  assert.deepEqual(await readFile(join(root, ".git/HEAD")), head);
  const help = await invokeRaw(root, ["init", "--help"], options);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--template-ref/);
  assert.match(help.stdout, /--name-file/);
});
