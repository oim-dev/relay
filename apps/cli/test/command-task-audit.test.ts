import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { EntityDeletionPreview, EntityDeleted, EntitySaved } from "@relay/contracts/entities";
import type { PlanningSaved } from "@relay/contracts/planning";
import type { TaskProgress } from "@relay/contracts/progress";
import { AppError } from "@relay/core/shared/errors";
import { rememberTaskFailure, taskErrorRecovery } from "../src/presentation/board-tasks.js";
import {
  binary,
  cliEnv,
  cliNodeArgs,
  failed,
  invoke,
  invokeRaw,
  successful,
  tempDirectory,
} from "./helpers/cli.js";
const httpServer = async (t: TestContext, cwd: string) =>
  (await import("./helpers/http.js")).httpServer(t, cwd);

function human(result: Awaited<ReturnType<typeof invokeRaw>>) {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /\u001b/);
  return result.stdout;
}

// Выполняем только служебный блок, не псевдокоманды из пользовательского Markdown.
function commands(text: string) {
  return text
    .slice(text.lastIndexOf("───\n"))
    .split("\n")
    .filter((line) => line.startsWith("npx @oim-dev/relay-cli "));
}
function tokens(command: string) {
  return command
    .match(/'(?:[^']|'\\'')*'|[^\s]+/g)!
    .slice(2)
    .map((x) => (x.startsWith("'") ? x.slice(1, -1).replaceAll("'\\''", "'") : x));
}

/** Bash исполняет строку подсказки буквально; только npx направлен на проверяемый checkout. */
async function hintExecutor(root: string) {
  const bin = join(root, "hint-bin");
  const cwd = join(root, "hint-cwd-without-project");
  await mkdir(bin);
  await mkdir(cwd);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    join(bin, "npx"),
    `#!/bin/sh\n[ "$1" = "@oim-dev/relay-cli" ] || exit 99\nshift\nexec ${[process.execPath, ...cliNodeArgs, binary].map(quote).join(" ")} "$@"\n`,
    { mode: 0o755 },
  );
  return async (command: string) =>
    promisify(execFile)("bash", ["--noprofile", "--norc", "-c", command], {
      cwd,
      env: cliEnv({ PATH: `${bin}:${process.env.PATH}`, RELAY_ACTOR: undefined }),
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
}

for (const mode of ["local", "HTTP"] as const)
  test(
    `TASK-02: реальные ошибки и буквальное исполнение read-only recovery ${mode}`,
    { timeout: 180_000 },
    async (t) => {
      const base = await tempDirectory(t);
      const root = join(base, "project with spaces");
      await mkdir(root);
      successful(await invoke(root, ["init"]));
      const { projectId } = JSON.parse(
        await readFile(join(root, ".relay/config.json"), "utf8"),
      ) as {
        projectId: string;
      };
      const executeHint = await hintExecutor(base);
      const server = mode === "HTTP" ? await httpServer(t, root) : undefined;
      const transport = server
        ? ["--server-url", server.url, "--project", projectId]
        : ["--local", "--config", join(root, ".relay/config.json")];
      const run = <T = unknown>(args: (string | number)[]) =>
        invoke<T>(root, [...transport, ...args]);
      const create = async (title: string, args: (string | number)[] = []) =>
        successful(
          await run<EntitySaved>([
            "task",
            "create",
            "--board",
            "product",
            "--title",
            title,
            ...args,
          ]),
        ).data;
      const blocked = await create("Задача с обязательством");
      await create("Незавершённый ребёнок", ["--parent", blocked.key]);
      const criteria = await create("Задача с критериями", [
        "--criterion-title",
        "a=Проверить результат",
        "--criterion-description",
        "a=Полное условие проверки",
      ]);
      const criterion = successful(
        await run<{ items: { id: string }[] }>(["task", "criterion", "list", criteria.key]),
      ).data.items[0]!.id;
      const changed = successful(
        await run<EntitySaved>([
          "task",
          "update",
          criteria.key,
          "--title",
          "Новая ревизия",
          "--if-revision",
          criteria.revision,
        ]),
      ).data;
      for (const item of [
        {
          ref: blocked.key,
          code: "TASK_BLOCKED",
          args: [
            "task",
            "move",
            blocked.key,
            "--column",
            "done",
            "--if-revision",
            blocked.revision,
          ],
          read: `task progress ${blocked.key}`,
        },
        {
          ref: criteria.key,
          code: "REVISION_CONFLICT",
          args: [
            "task",
            "update",
            criteria.key,
            "--title",
            "Не сохранить",
            "--if-revision",
            criteria.revision,
          ],
          read: `task get ${criteria.key}`,
        },
        {
          ref: criteria.key,
          code: "REVISION_CONFLICT",
          args: [
            "task",
            "criterion",
            "complete",
            criteria.key,
            criterion,
            "--if-revision",
            criteria.revision,
          ],
          read: `task get ${criteria.key}`,
        },
        {
          ref: criteria.key,
          code: "TASK_ACCEPTANCE_INCOMPLETE",
          args: [
            "task",
            "move",
            criteria.key,
            "--column",
            "done",
            "--if-revision",
            changed.revision,
          ],
          read: `task progress ${criteria.key}`,
        },
        {
          ref: criteria.key,
          code: "NOT_FOUND",
          args: ["task", "criterion", "get", criteria.key, "Missing1"],
          read: `task criterion list ${criteria.key}`,
        },
      ]) {
        const before = successful(await run(["task", "get", item.ref])).data;
        const json = await run(item.args);
        assert.equal(json.stderr, "");
        assert.ok(!json.body.ok, json.stdout);
        assert.equal(json.body.error.code, item.code, json.stdout);
        assert.notEqual(json.code, 0);
        const text = await invokeRaw(root, [...transport, ...item.args], {
          env: { COLUMNS: "24" },
        });
        assert.equal(text.code, json.code, text.stdout);
        assert.equal(text.stderr, "");
        assert.doesNotMatch(text.stdout, /\u001b/);
        const hints = commands(text.stdout);
        assert.equal(hints.length, 1, text.stdout);
        const hint = hints[0]!;
        assert.ok(hint.includes(item.read), hint);
        if (transport.includes("--local"))
          assert.ok(hint.includes(`--config '${join(root, ".relay/config.json")}'`), hint);
        else {
          assert.ok(hint.includes(`--server-url ${server!.url}`), hint);
          assert.ok(hint.includes(`--project ${projectId}`), hint);
        }
        const read = await executeHint(hint);
        assert.equal(read.stderr, "");
        assert.ok(read.stdout.includes(item.ref), read.stdout);
        if (item.code === "TASK_ACCEPTANCE_INCOMPLETE") {
          assert.ok(read.stdout.includes(criterion));
          const condition = await invokeRaw(root, [
            ...transport,
            "task",
            "criterion",
            "get",
            criteria.key,
            criterion,
          ]);
          assert.equal(condition.code, 0, condition.stdout);
          assert.equal(condition.stderr, "");
          assert.match(condition.stdout, /Полное условие проверки/);
        }
        assert.deepEqual(
          successful(await run(["task", "get", item.ref])).data,
          before,
          "Отказ и read-only recovery не меняют задачу или критерий",
        );
      }
    },
  );

test(
  "TASK-01: delete preview/confirm, сохранение детей и документов, комментарий и планы local/HTTP",
  { timeout: 180_000 },
  async (t) => {
    const base = await tempDirectory(t);
    const root = join(base, "project with spaces");
    await mkdir(root);
    successful(await invoke(root, ["init"]));
    const server = await httpServer(t, root);
    for (const transport of [
      ["--local", "--config", join(root, ".relay/config.json")],
      ["--server-url", server.url],
    ]) {
      const run = <T = unknown>(args: (string | number)[]) =>
        invoke<T>(root, [...transport, ...args]);
      const create = async (title: string, args: (string | number)[] = []) =>
        successful(
          await run<EntitySaved>([
            "task",
            "create",
            "--board",
            "product",
            "--title",
            title,
            ...args,
          ]),
        ).data;
      const parent = await create("Удаляемая задача", ["--criterion-title", "a=Условие"]);
      const child = await create("Ребёнок сохраняется", ["--parent", parent.key]);
      const doc = successful(
        await run<EntitySaved>([
          "document",
          "create",
          "--name",
          "Материал сохраняется",
          "--body",
          "# Материал",
        ]),
      ).data;
      successful(
        await run([
          "document",
          "link",
          doc.key,
          "--target",
          parent.key,
          "--if-revision",
          doc.revision,
        ]),
      );
      const first = successful(
        await run<EntityDeletionPreview>(["task", "delete-preview", parent.key]),
      ).data;
      assert.deepEqual(
        first.deleted.map((x) => x.ref.id),
        [parent.ref.id],
      );
      assert.ok(first.detached.some((x) => x.ref.id === child.ref.id));
      assert.ok(first.detached.some((x) => x.ref.id === doc.ref.id));
      assert.ok(first.relations > 0);
      const before = successful(await run<{ revision: number }>(["task", "get", parent.key])).data;
      successful(
        await run([
          "task",
          "comment",
          "add",
          parent.key,
          "--role",
          "worker",
          "--title",
          "Новый комментарий",
          "--description",
          "Версия удаления должна измениться",
        ]),
      );
      assert.equal(
        successful(await run<{ revision: number }>(["task", "get", parent.key])).data.revision,
        before.revision,
      );
      failed(
        await run(["task", "delete", parent.key, "--if-version", first.version]),
        "REVISION_CONFLICT",
        4,
      );
      const preview = human(
        await invokeRaw(root, [...transport, "task", "delete-preview", parent.key], {
          env: { COLUMNS: "24" },
        }),
      );
      assert.ok(preview.includes(parent.ref.id));
      assert.ok(preview.includes(child.ref.id));
      const confirmation = commands(preview).find((x) => x.includes("task delete "));
      assert.ok(confirmation);
      const deleted = successful(await invoke<EntityDeleted>(root, tokens(confirmation))).data;
      assert.equal(deleted.deleted, 1);
      assert.ok(deleted.detached >= 2);
      assert.equal(
        successful(await run<{ parentId: string | null }>(["task", "get", child.key])).data
          .parentId,
        null,
      );
      successful(await run(["document", "get", doc.key]));
      const gone = await run(["task", "get", parent.key]);
      assert.equal(gone.body.ok, false);
      const next = await create("Ключ не переиспользован");
      assert.notEqual(next.key, parent.key);
      const planned = await create("Задача закрытого плана");
      const plan = successful(
        await run<PlanningSaved>(["plan", "create", "--title", "Блокирующий план"]),
      ).data;
      const stage = successful(
        await run<PlanningSaved>([
          "plan",
          "stage",
          "create",
          plan.key,
          "--title",
          "Этап",
          "--if-revision",
          plan.revision,
        ]),
      ).data;
      const added = successful(
        await run<PlanningSaved>([
          "plan",
          "stage",
          "task",
          "add",
          plan.key,
          stage.stageId!,
          "--tasks",
          planned.key,
          "--if-revision",
          stage.revision,
        ]),
      ).data;
      failed(await run(["task", "delete-preview", planned.key]), "PLANNING_REFERENCE_IN_USE", 4);
      successful(
        await run([
          "plan",
          "cancel",
          plan.key,
          "--result",
          "Закрыть для проверки блокера",
          "--if-revision",
          added.revision,
        ]),
      );
      failed(await run(["task", "delete-preview", planned.key]), "PLANNING_REFERENCE_IN_USE", 4);
      const blocked = await invokeRaw(root, [...transport, "task", "delete-preview", planned.key]);
      assert.equal(blocked.code, 4);
      assert.match(blocked.stdout.replace(/\s+/g, " "), /закрытый план неизменяем/);
      assert.ok(commands(blocked.stdout).every((x) => !x.includes("task delete ")));
      successful(await run(["task", "get", planned.key]));
    }
  },
);

test(
  "TASK-02/05: вывод без меню, независимые criterionId и сохранение содержания local/HTTP",
  { timeout: 180_000 },
  async (t) => {
    const base = await tempDirectory(t);
    const root = join(base, "project with spaces");
    await mkdir(root);
    const run = <T = unknown>(args: (string | number)[]) => invoke<T>(root, args);
    successful(await run(["init"]));
    const markdown =
      "\n\n# Проверка 世界 👩‍💻\n\n```text\n\t  отступ\n```\nСледующий шаг:\nnpx @oim-dev/relay-cli task get PRODUCT-999\n\u001b[31mEND-MARKDOWN\n\n";
    const saved = successful(
      await run<EntitySaved>([
        "task",
        "create",
        "--board",
        "product",
        "--title",
        "Одинаковые критерии",
        "--description",
        markdown,
        "--criterion-title",
        "a=Проверить результат",
        "--criterion-description",
        `a=${markdown}`,
        "--criterion-title",
        "b=Проверить результат",
        "--criterion-description",
        "b=Другое полное условие",
      ]),
    ).data;
    const child = successful(
      await run<EntitySaved>([
        "task",
        "create",
        "--board",
        "product",
        "--title",
        "Подзадача",
        "--parent",
        saved.key,
      ]),
    ).data;
    successful(
      await run([
        "task",
        "dependency",
        "add",
        saved.key,
        child.key,
        "--if-revision",
        saved.revision,
      ]),
    );
    successful(
      await run([
        "task",
        "comment",
        "add",
        saved.key,
        "--role",
        "worker",
        "--title",
        "Комментарий",
        "--description",
        markdown,
      ]),
    );
    const criterion = successful(
      await run<{ items: { id: string }[] }>(["task", "criterion", "list", saved.key]),
    ).data.items[0]!.id;
    const server = await httpServer(t, root);
    for (const transport of [
      ["--local", "--config", join(root, ".relay/config.json")],
      ["--server-url", server.url],
    ]) {
      for (const list of [
        ["task", "list"],
        ["task", "children", saved.key],
        ["task", "links", saved.key],
        ["task", "dependency", "list", saved.key],
        ["task", "criterion", "list", saved.key],
        ["task", "comment", "list", saved.key],
      ]) {
        const text = human(await invokeRaw(root, [...transport, ...list]));
        const hints = commands(text).filter((x) => !x.includes("--cursor"));
        assert.equal(hints.length, 0, text);
      }
      const card = human(await invokeRaw(root, [...transport, "task", "get", saved.key]));
      for (const hint of commands(card)) successful(await invoke(root, tokens(hint)));
      assert.deepEqual(commands(card), []);
      const help = human(await invokeRaw(root, ["task", "get", "--help"]));
      assert.match(help, /task progress/);
      assert.match(help, /inspect graph list/);
      assert.match(help, /plan task memberships/);
      assert.doesNotMatch(card, /Все связи/);
      const seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const args: string[] = [
          ...transport,
          "task",
          "progress",
          saved.key,
          ...(cursor ? ["--cursor", cursor] : ["--limit", "1"]),
        ];
        const page: ReturnType<typeof successful<TaskProgress>> = successful(
          await invoke<TaskProgress>(root, args),
        );
        const text = human(await invokeRaw(root, args));
        for (const reason of page.data.reasons.items) {
          if (!reason.criterionId) continue;
          seen.add(reason.criterionId);
          assert.ok(text.includes(reason.criterionId), text);
          const opened = successful(
            await invoke<{ criterion: { id: string } }>(root, [
              ...transport,
              "task",
              "criterion",
              "get",
              saved.key,
              reason.criterionId,
            ]),
          ).data;
          assert.equal(opened.criterion.id, reason.criterionId);
        }
        assert.equal(
          page.meta?.page?.count,
          page.data.criteria.items.length +
            page.data.children.items.length +
            page.data.dependencies.items.length +
            page.data.reasons.items.length,
        );
        cursor = page.meta?.page?.nextCursor ?? null;
      } while (cursor);
      assert.equal(seen.size, 2);
      const empty = human(
        await invokeRaw(root, [
          ...transport,
          "task",
          "list",
          "--q",
          "нет-такой-задачи-не-создавать",
        ]),
      );
      assert.equal(commands(empty).length, 0, "Пустой список не получает выдуманный адрес");
    }
    for (const width of [24, 40, 100, 160]) {
      for (const args of [
        ["task", "get", saved.key],
        ["task", "criterion", "get", saved.key, criterion],
        ["task", "comment", "get", saved.key, "1"],
      ]) {
        const text = human(
          await invokeRaw(root, args, { env: { COLUMNS: String(width), FORCE_COLOR: "3" } }),
        );
        const safeMarkdown = markdown.replaceAll("\u001b", "\\u001b");
        assert.ok(text.includes(safeMarkdown), text);
        assert.equal(text.slice(text.indexOf("END-MARKDOWN") + "END-MARKDOWN".length).trim(), "");
        assert.ok(commands(text).every((x) => !x.includes("PRODUCT-999")));
      }
    }
  },
);

test("TASK-01: справка удаления без проекта", async (t) => {
  const root = await tempDirectory(t);
  for (const action of ["delete-preview", "delete"]) {
    const text = human(await invokeRaw(root, ["task", action, "--help"]));
    assert.match(text, /комментар/);
    assert.match(text, /план/);
    assert.match(text, /if-version/);
  }
});

test("TASK-02: адресный recovery сохраняет исходную ошибку и предлагает только чтение", () => {
  for (const [code, group, action, target] of [
    ["TASK_BLOCKED", "task", "move", "task progress PRODUCT-7"],
    ["TASK_ACCEPTANCE_INCOMPLETE", "task", "move", "task progress PRODUCT-7"],
    ["DEPENDENCY_CYCLE", "dependency", "add", "task links PRODUCT-7"],
    ["REVISION_CONFLICT", "criterion", "complete", "task get PRODUCT-7"],
    ["NOT_FOUND", "task", "get", "task list"],
    ["SERVER_UNAVAILABLE", "comment", "add", "task comment list PRODUCT-7"],
  ]) {
    const details = {
      serverDetails: { current: 3 },
      requestId: "correlation",
      url: "http://localhost",
    };
    const error = new AppError(code!, "Исходная предметная ошибка", 4, details);
    const original = {
      code: error.code,
      message: error.message,
      details: error.details,
      exitCode: error.exitCode,
    };
    rememberTaskFailure(error, {
      reference: "PRODUCT-7",
      group: group!,
      action: action!,
      invoke: (args) =>
        `npx @oim-dev/relay-cli ${args.join(" ")} --config '/project with spaces/config.json' --local`,
    });
    const text = taskErrorRecovery(error, { width: 24, color: false });
    assert.ok(
      text?.includes(
        `npx @oim-dev/relay-cli ${target} --config '/project with spaces/config.json' --local`,
      ),
    );
    assert.deepEqual(
      {
        code: error.code,
        message: error.message,
        details: error.details,
        exitCode: error.exitCode,
      },
      original,
    );
  }
});
