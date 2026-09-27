import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { initialize } from "@relay/core/storage/workspace";
import { initializeRegistry, registerProject } from "@relay/project-runtime/registry";
import { startServer } from "@relay/server-runtime";
import { createProgram } from "../../../apps/cli/src/program.ts";
import { runtime } from "../../../apps/cli/src/context.ts";
import { repoRoot } from "./lib.mjs";
import { diagnose } from "../src/scripts/diagnose.mjs";

// Проверяется CLI из исходников; npm и внешняя поставка в этом тесте не запускаются.
const OBSERVED =
  "Учебная фикстура проверки; внешняя разработка не выполнялась. Далее: продолжение.";

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
    await createProgram(context).parseAsync([...connection, ...args], { from: "user" });
    assert(output.trim(), "CLI не показал результат");
    return output;
  } finally {
    stdout.destroy();
  }
}

for (const mode of ["local", "workspace"])
  for (const passed of [true, false])
    test(`CLI-пример из поставки: ${mode}, проверка ${passed ? "успешна" : "неуспешна"}`, async (t) => {
      const artifacts = join(repoRoot, ".artifacts");
      await mkdir(artifacts, { recursive: true });
      const root = await mkdtemp(join(artifacts, "skill cli example "));
      let api;
      t.after(async () => {
        try {
          await api?.close();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
      await initialize(join(root, "app"), "tasks");
      let connection = ["--local", "--config", join(root, "app/.relay/config.json")];
      if (mode === "workspace") {
        const registry = await initializeRegistry(root);
        await registerProject(registry.configPath, "demo", { path: "app" });
        api = await startServer({ cwd: root, config: registry.configPath, actor: "test", port: 0 });
        const diagnostic = await diagnose({ root, project: "demo", serverUrl: api.url }, {});
        assert.equal(diagnostic.server.state, "reachable");
        assert.equal(diagnostic.server.identity, "matched");
        connection = [
          "--config",
          registry.configPath,
          "--server-url",
          api.url,
          "--project",
          "demo",
        ];
      }
      const markdown = await readFile(
        join(repoRoot, "skills/relay/references/agent/EXAMPLES.md"),
        "utf8",
      );
      const blocks = [...markdown.matchAll(/```bash\n# relay-example: ([\w-]+)\n([\s\S]*?)\n```/g)];
      assert.equal(blocks.length, 32, "Потерян шаг опубликованного CLI-примера");
      const values = {
        OBSERVED_RESULT: OBSERVED,
        RELEASE_VERSION: "1.0-demo",
        DEPLOYMENT_EVIDENCE: "Учебная фикстура поставки, реальная выкладка не выполнялась",
      };
      // JSON используется только для отладочных проверок сохранённого состояния.
      // Сами опубликованные команды исполняются ровно с обычным текстовым выводом.
      const cli = async (...args) => {
        const result = JSON.parse(await runCli(root, connection, [...args, "--format", "json"]));
        assert.equal(result.ok, true);
        return result.data;
      };
      const results = new Map();
      for (const [, step, code] of blocks) {
        if (!passed && step === "criteria") break;
        // Bash разбирает именно опубликованные кавычки и подстановки. Подмена npx
        // только извлекает argv, после чего его исполняет настоящий парсер CLI.
        const tokens = execFileSync(
          "bash",
          ["--noprofile", "--norc", "-eu", "-c", 'npx() { printf "%s\\0" "$@"; };\n' + code],
          {
            env: values,
            encoding: "utf8",
          },
        ).split("\0");
        assert.equal(tokens.pop(), "");
        assert.equal(tokens.shift(), "@oim-dev/relay-cli");
        assert(!tokens.includes("--format"), "Пример должен использовать обычный вывод");
        const text = await runCli(root, connection, tokens);
        assert(!text.trim().startsWith('{"ok"'), "Вместо читаемого вывода получен JSON-конверт");
        const created = {
          document: ["DOCUMENT_ID", "document", "Учебное ТЗ"],
          product: ["PRODUCT_ID", "product", "Учебный каталог"],
          feature: ["FEATURE_ID", "feature", "Просмотр каталога"],
          scenario: ["SCENARIO_ID", "scenario", "Открыть каталог"],
          application: ["APP_ID", "application", "Web"],
          si: ["SI_ID", "implementation", "Открытие каталога в Web"],
          task: ["TASK_ID", "task", "Реализовать просмотр каталога"],
          plan: ["PLAN_ID", "work-plan", "Просмотр каталога"],
          release: ["RELEASE_ID", "release", "Учебный выпуск"],
        };
        if (created[step]) {
          const [variable, kind, title] = created[step];
          const found = await cli("entities", "list", "--kind", kind, "--q", title);
          assert.equal(found.items.length, 1);
          values[variable] = found.items[0].ref.id;
          assert(
            text.includes(found.items[0].key) || text.includes(values[variable]),
            `В выводе ${step} отсутствует адрес созданной записи`,
          );
        }
        if (step === "scenario")
          values.DOCUMENT_RELATIONS = JSON.stringify([
            {
              target: { kind: "product", id: values.PRODUCT_ID },
              type: "documents",
              description: "Исходное требование",
            },
            {
              target: { kind: "scenario", id: values.SCENARIO_ID },
              type: "references",
              description: "Основание сценария",
            },
          ]);
        // Только команды чтения повторяются в отладочном формате, мутации — никогда.
        let result;
        if (!tokens.includes("--actor")) {
          result = await cli(...tokens);
          results.set(step, result);
          if (result.revision !== undefined)
            assert(text.includes(String(result.revision)), `Не показана ревизия на шаге ${step}`);
        }
        if (step === "document-read") values.DOCUMENT_REVISION = String(result.revision);
        if (["plan-read", "plan-reread", "plan-before-complete"].includes(step))
          values.PLAN_REVISION = String(result.revision);
        if (["task-read", "task-before-criterion", "task-before-done"].includes(step))
          values.TASK_REVISION = String(result.revision);
        if (step === "stage") {
          const stages = await cli("plan", "stages", values.PLAN_ID);
          values.STAGE_ID = stages.items[0].id;
          assert(text.includes(values.STAGE_ID), "Не показан ID созданного этапа");
        }
        if (step === "criteria") {
          values.CRITERION_ID = result.items[0].id;
          assert(text.includes(values.CRITERION_ID), "Не показан ID критерия");
        }
        if (step === "release-read") values.RELEASE_REVISION = String(result.revision);
        if (step === "progress") assert.equal(result.completed, true);
      }
      const document = results.get("document-check");
      assert(document.data.body.includes("Пользователь открывает каталог"));
      assert.equal(document.data.relations.length, 2);
      const graph = await cli("graph", "context", values.SCENARIO_ID);
      assert.equal(graph.complete, true);
      assert(graph.nodes.some((node) => node.ref.id === values.DOCUMENT_ID));
      const task = await cli("task", "get", values.TASK_ID);
      assert.equal(task.column, passed ? "done" : "in-progress");
      assert(task.description.includes("Выполнить связанный сценарий"));
      const comments = await cli("task", "comment", "list", values.TASK_ID);
      assert.equal(comments.items.length, 1);
      const comment = await cli(
        "task",
        "comment",
        "get",
        values.TASK_ID,
        String(comments.items[0].id),
      );
      assert.equal(comment.description, OBSERVED);
      const criteria = await cli("task", "criterion", "list", values.TASK_ID);
      assert.equal(criteria.items[0].completed, passed);
      const plan = await cli("plan", "get", values.PLAN_ID);
      assert.equal(plan.status, passed ? "completed" : "draft");
      const members = await cli("plan", "tasks", values.PLAN_ID, values.STAGE_ID);
      assert.equal(members.items.length, 1);
      const releases = await cli("release", "list");
      assert.equal(releases.items.length, passed ? 1 : 0);
      if (passed) assert.equal(results.get("release-check").status, "released");
    });
