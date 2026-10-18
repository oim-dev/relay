import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { initialize, openWorkspace } from "@relay/core/storage/workspace";
import { BoardRepository } from "@relay/core/storage/boards";
import { initializeRegistry, registerProject } from "@relay/project-runtime/registry";
import { startServer } from "@relay/server-runtime";
import { createProgram } from "../../../apps/cli/src/program.ts";
import { runtime } from "../../../apps/cli/src/context.ts";
import { repoRoot } from "./lib.mjs";

async function runCli(root, connection, args) {
  let output = "";
  const stdout = new Writable({
    write(chunk, _encoding, done) {
      output += chunk.toString();
      done();
    },
  });
  const context = runtime(Readable.from([]), stdout, root);
  context.env = {};
  try {
    try {
      await createProgram(context).parseAsync([...connection, ...args], { from: "user" });
    } catch (error) {
      if (error.code !== "commander.helpDisplayed" || error.exitCode !== 0) throw error;
    }
    assert(output.trim(), "CLI не показал результат");
    return output;
  } finally {
    stdout.destroy();
  }
}

async function fixture(t, mode) {
  await mkdir(join(repoRoot, ".artifacts"), { recursive: true });
  const root = await mkdtemp(join(repoRoot, ".artifacts/skill workflow "));
  let server;
  t.after(async () => {
    try {
      await server?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  await initialize(join(root, "app"), "tasks");
  // Сценарий существующего проекта: новый init уже не создаёт инфраструктурную доску.
  const workspace = await openWorkspace(join(root, "app"));
  await workspace.locked((owned) =>
    new BoardRepository(workspace).ensure(
      {
        version: 1,
        id: "Infra001",
        slug: "infrastructure",
        prefix: "INFRA",
        kind: "infrastructure",
        applicationId: null,
        revision: 1,
        createdAt: "2026-09-26T00:00:00.000Z",
        createdBy: "relay",
      },
      owned,
    ),
  );
  let connection = ["--local", "--config", join(root, "app/.relay/config.json")];
  if (mode === "workspace") {
    const registry = await initializeRegistry(root);
    await registerProject(registry.configPath, "demo", { path: "app" });
    server = await startServer({ cwd: root, config: registry.configPath, actor: "test", port: 0 });
    connection = ["--config", registry.configPath, "--server-url", server.url, "--project", "demo"];
  }
  const text = (args) => runCli(root, connection, args.map(String));
  // Машинный формат используется только этим автоматическим проверочным сценарием.
  const request = async (args, actor = "skill-worker") =>
    JSON.parse(await text([...args, "--actor", actor, "--format", "json"]));
  const json = async (args, actor) => {
    const response = await request(args, actor);
    assert.equal(response.ok, true, JSON.stringify(response.error));
    return response.data;
  };
  const failure = async (args, code) => {
    await assert.rejects(request(args), { code });
  };
  const revision = async (kind, ref) => (await json([kind, "get", ref])).revision;
  return { root, text, json, failure, revision };
}

const id = (saved) => saved.id ?? saved.ref.id;

test("четыре примера help из поставки исполняются без проекта", async () => {
  const skill = await readFile(join(repoRoot, "skills/relay/SKILL.md"), "utf8");
  const commands = [...skill.matchAll(/^npx @oim-dev\/relay-cli (.*--help)$/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(commands, ["--help", "overview --help", "task --help", "task create --help"]);
  for (const command of commands) {
    const text = await runCli(join(repoRoot, "packages/relay-skill"), [], command.split(" "));
    assert.match(text, /Usage: npx @oim-dev\/relay-cli/);
    assert.doesNotMatch(text, /"ok":false/);
  }
});

for (const mode of ["local", "workspace"]) {
  test(`знания → задача и отчёт → план → релиз: ${mode}`, async (t) => {
    const app = await fixture(t, mode);
    const { json, failure, revision } = app;
    const markdown = "## Требование\n\nРазличать результат, пустую выдачу и ошибку поиска.\n";
    const feature = id(
      await json(["feature", "create", "--name", "Поиск", "--description", markdown]),
    );
    assert.equal((await json(["feature", "get", feature])).data.description, markdown);
    const scenario = id(
      await json([
        "scenario",
        "create",
        "--feature",
        feature,
        "--name",
        "Открыть инструкцию",
        "--description",
        "Учебный сценарий: найти и открыть результат.",
      ]),
    );
    const application = id(
      await json([
        "application",
        "create",
        "--name",
        "Web",
        "--slug",
        "web",
        "--prefix",
        "CHECK",
        "--description",
        "Web-вклад учебной фикстуры.",
      ]),
    );
    const implementation = (target, title) => [
      "implementation",
      "create",
      "--application",
      application,
      "--target",
      target,
      "--title",
      title,
      "--description",
      "Учебный вклад в общий результат.",
    ];
    await failure(implementation(scenario, "SI до FI"), "INVALID_REFERENCE");
    await json(implementation(feature, "Поиск в Web"));
    const si = id(await json(implementation(scenario, "Открытие в Web")));
    const task = id(
      await json([
        "task",
        "create",
        "--board",
        "CHECK",
        "--title",
        "Проверить отчёт",
        "--description",
        "Проверка сохранения Markdown через CLI.",
        "--targets",
        si,
        "--criterion-title",
        "saved=Полный материал сохранён",
      ]),
    );
    await failure(
      [
        "task",
        "create",
        "--board",
        "infrastructure",
        "--title",
        "Несовместимая цель",
        "--targets",
        feature,
      ],
      "INVALID_REFERENCE",
    );
    const infra = id(
      await json([
        "task",
        "create",
        "--board",
        "infrastructure",
        "--title",
        "Подготовить проверку",
      ]),
    );
    assert.deepEqual((await json(["task", "get", infra])).productLinks, []);

    const before = await revision("task", task);
    const report =
      "## Результат\n\nМатериал учебной проверки.\n\n## Ограничения\n\nПрикладной код не реализовывался.";
    const comment = await json([
      "task",
      "comment",
      "add",
      task,
      "--role",
      "worker",
      "--title",
      "Итог",
      "--description",
      report,
    ]);
    const saved = await json(["task", "comment", "get", task, comment.commentId]);
    assert.equal(saved.description, report);
    assert.equal(saved.actorRole, "worker");
    assert.equal(await revision("task", task), before);
    assert((await app.text(["task", "comment", "get", task, comment.commentId])).includes(report));
    await failure(
      ["task", "move", task, "--column", "done", "--if-revision", before],
      "TASK_ACCEPTANCE_INCOMPLETE",
    );
    const criterion = (await json(["task", "criterion", "list", task])).items[0].id;
    await json(["task", "criterion", "complete", task, criterion, "--if-revision", before]);
    await json([
      "task",
      "move",
      task,
      "--column",
      "done",
      "--if-revision",
      await revision("task", task),
    ]);

    const createPlan = async (title) => {
      const plan = id(
        await json(["plan", "create", "--title", title, "--goal", "Проверенный результат."]),
      );
      const stage = await json([
        "plan",
        "stage",
        "create",
        plan,
        "--title",
        "Проверка",
        "--if-revision",
        await revision("plan", plan),
      ]);
      return { plan, stage: stage.stageId };
    };
    const { plan, stage } = await createPlan("Первый план");
    await json([
      "plan",
      "stage",
      "task",
      "add",
      plan,
      stage,
      "--tasks",
      task,
      "--if-revision",
      await revision("plan", plan),
    ]);
    const other = await createPlan("Другой открытый план");
    await failure(
      [
        "plan",
        "stage",
        "task",
        "add",
        other.plan,
        other.stage,
        "--tasks",
        task,
        "--if-revision",
        await revision("plan", other.plan),
      ],
      "TASK_IN_PLAN",
    );
    const release = id(
      await json([
        "release",
        "create",
        "--title",
        "Учебный выпуск",
        "--release-version",
        "test",
        "--plans",
        plan,
        "--description",
        "Проверка записи выпуска; внешняя поставка не выполнялась.",
      ]),
    );
    await failure(
      ["release", "publish", release, "--if-revision", await revision("release", release)],
      "RELEASE_INCOMPLETE",
    );
    await json([
      "plan",
      "complete",
      plan,
      "--result",
      "Сценарий фикстуры проверен.",
      "--if-revision",
      await revision("plan", plan),
    ]);
    await json([
      "release",
      "publish",
      release,
      "--if-revision",
      await revision("release", release),
    ]);
    assert.equal((await json(["release", "get", release])).status, "released");
    assert.match(await app.text(["overview", "--view", "full"]), /Учебный выпуск/);
  });

  test(`история: результат ребёнка требует явного принятия родителем: ${mode}`, async (t) => {
    const app = await fixture(t, mode);
    const { json, failure } = app;
    const started = await json([
      "session",
      "start",
      "--title",
      "Проверить передачу результата",
      "--description",
      "Учебная история.",
    ]);
    const session = started.session.id;
    const run = started.run.id;
    const opened = await json([
      "checkpoint",
      "open",
      session,
      "--run",
      run,
      "--if-revision",
      started.session.revision,
      "--title",
      "Намерение",
      "--body",
      "Проверить сохранение и принятие материала.",
    ]);
    const intent = opened.checkpoint.id;
    const fork = await json([
      "session",
      "fork",
      intent,
      "--run",
      run,
      "--if-revision",
      opened.session.revision,
      "--title",
      "Поручение ребёнку",
      "--description",
      "Подготовить полный материал.",
    ]);
    const child = fork.childSession.id;
    const attached = await json(
      ["session", "attach", child, "--if-revision", fork.childSession.revision],
      "child-worker",
    );
    const childRun = attached.run.id;
    const childIntent = await json(
      [
        "checkpoint",
        "open",
        child,
        "--run",
        childRun,
        "--if-revision",
        attached.session.revision,
        "--title",
        "Намерение ребёнка",
        "--body",
        "Сохранить проверяемый результат.",
      ],
      "child-worker",
    );
    const body =
      "## Результат\n\nУчебный материал готов к чтению.\n\n## Проверка\n\nВнешняя реализация не выполнялась.";
    const childResult = await json(
      [
        "checkpoint",
        "complete",
        childIntent.checkpoint.id,
        "--run",
        childRun,
        "--if-revision",
        childIntent.session.revision,
        "--title",
        "Результат ребёнка",
        "--body",
        body,
      ],
      "child-worker",
    );
    await json(
      [
        "session",
        "complete",
        child,
        "--run",
        childRun,
        "--if-revision",
        childResult.session.revision,
        "--result",
        "Материал передан для приёмки.",
      ],
      "child-worker",
    );
    assert.equal(childResult.checkpoint.createdBy, "child-worker");
    assert.equal((await json(["checkpoint", "get", childResult.checkpoint.id])).body, body);
    assert((await app.text(["session", "context", child])).includes(body));
    await failure(
      [
        "checkpoint",
        "complete",
        intent,
        "--run",
        run,
        "--if-revision",
        fork.session.revision,
        "--title",
        "Закрытие без приёмки",
        "--body",
        "Ожидается предметный отказ.",
      ],
      "WORK_CHILDREN_UNACCEPTED",
    );
    const accepted = await json([
      "checkpoint",
      "save",
      intent,
      "--run",
      run,
      "--if-revision",
      fork.session.revision,
      "--title",
      "Материал принят",
      "--body",
      "Полный результат прочитан и проверен.",
      "--accept",
      child,
    ]);
    assert.equal(
      (await json(["session", "get", child])).acceptance.checkpointId,
      accepted.checkpoint.id,
    );
    const result = await json([
      "checkpoint",
      "complete",
      intent,
      "--run",
      run,
      "--if-revision",
      accepted.session.revision,
      "--title",
      "Проверка завершена",
      "--body",
      "Приёмка явно сохранена.",
    ]);
    await json([
      "session",
      "complete",
      session,
      "--run",
      run,
      "--if-revision",
      result.session.revision,
      "--result",
      "Сценарий завершён с явным принятием ребёнка.",
    ]);
    assert.equal((await json(["session", "intents", session])).total, 0);
    assert.equal((await json(["session", "get", session])).session.status, "completed");
  });
}
