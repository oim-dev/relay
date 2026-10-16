import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PlanCompact, PlanSummary, PlanningSaved } from "@relay/contracts/planning";
import type { EntitySaved, EntityDeletionPreview } from "@relay/contracts/entities";
import type { WorkPlanProgress } from "@relay/contracts/progress";
import { failed, invoke, invokeRaw, successful, tempDirectory } from "./helpers/cli.js";
import { httpServer } from "./helpers/http.js";

type Page<T> = { items: T[]; total: number; nextOffset: number | null; version: string };
const human = (result: Awaited<ReturnType<typeof invokeRaw>>) => {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /\u001b/);
  return result.stdout;
};
const tokens = (command: string) =>
  command
    .match(/'(?:[^']|'\\'')*'|[^\s]+/g)!
    .slice(2)
    .map((arg) => (arg.startsWith("'") ? arg.slice(1, -1).replaceAll("'\\''", "'") : arg));
const commands = (text: string) =>
  text
    .slice(Math.max(0, text.lastIndexOf("───\n")))
    .split("\n")
    .filter((line) => line.startsWith("npx @oim-dev/relay-cli "));

test(
  "PLAN-01/02: HTTP очистка участников и адресная навигация независимо от compact",
  { timeout: 120_000 },
  async (t) => {
    const base = await tempDirectory(t);
    const root = join(base, "project with spaces");
    await mkdir(root);
    successful(await invoke(root, ["init"]));
    successful(await invoke(base, ["workspace", "project", "init"]));
    const server = await httpServer(t, base);
    successful(
      await invoke(base, [
        "--server-url",
        server.url,
        "workspace",
        "project",
        "add",
        "alpha",
        root,
      ]),
    );
    const transport = ["--server-url", server.url, "--project", "alpha"];
    const run = <T = unknown>(args: (string | number)[]) =>
      invoke<T>(base, [...transport, ...args]);
    const raw = (args: (string | number)[]) =>
      invokeRaw(base, [...transport, ...args], { env: { COLUMNS: "40" } });
    const plan = successful(
      await run<PlanningSaved>([
        "plan",
        "create",
        "--title",
        "Участники HTTP",
        "--participants",
        "Участник",
      ]),
    ).data;
    successful(
      await run(["plan", "update", plan.key, "--summary", "Пропуск сохраняет", "--if-revision", 1]),
    );
    assert.deepEqual(
      successful(await run<PlanSummary>(["plan", "get", plan.key])).data.participants,
      ["Участник"],
    );
    failed(
      await run([
        "plan",
        "update",
        plan.key,
        "--clear-participants",
        "--participants",
        "Нельзя",
        "--if-revision",
        2,
      ]),
      "CONFLICTING_OPTIONS",
    );
    failed(
      await run(["plan", "update", plan.key, "--clear-participants", "--if-revision", 1]),
      "REVISION_CONFLICT",
      4,
    );
    successful(await run(["plan", "update", plan.key, "--clear-participants", "--if-revision", 2]));
    assert.deepEqual(
      successful(await run<PlanSummary>(["plan", "get", plan.key])).data.participants,
      [],
    );
    const stage = successful(
      await run<PlanningSaved>([
        "plan",
        "stage",
        "create",
        plan.key,
        "--title",
        "Этап HTTP",
        "--if-revision",
        3,
      ]),
    ).data;
    const task = successful(
      await run<EntitySaved>(["task", "create", "--board", "product", "--title", "Работа HTTP"]),
    ).data;
    const included = successful(
      await run<PlanningSaved>([
        "plan",
        "stage",
        "task",
        "add",
        plan.key,
        stage.stageId!,
        "--tasks",
        task.key,
        "--if-revision",
        stage.revision,
      ]),
    ).data;
    let text = human(await raw(["plan", "list"]));
    for (const args of [
      ["plan", "get", plan.key],
      ["plan", "stage", "list", plan.key],
      ["plan", "stage", "get", plan.key, stage.stageId!],
      ["plan", "stage", "task", "list", plan.key, stage.stageId!],
      ["task", "get", task.key],
    ]) {
      assert.deepEqual(commands(text), []);
      text = human(await raw(args));
    }
    const refusal = await raw([
      "plan",
      "stage",
      "remove",
      plan.key,
      stage.stageId!,
      "--if-revision",
      included.revision,
    ]);
    assert.equal(refusal.code, 4);
    const recovery = commands(refusal.stdout).find((line) => line.includes("plan stage task list"));
    assert.ok(recovery);
    assert.ok(recovery.includes(server.url));
    assert.ok(recovery.includes("--project alpha"));
    human(await invokeRaw(base, tokens(recovery)));
  },
);

test(
  "PLAN-01/02/05: compact opt-in, legacy JSON и cursor; HTTP workspace с адресным чтением",
  { timeout: 180_000 },
  async (t) => {
    const base = await tempDirectory(t);
    const root = join(base, "project with spaces");
    await mkdir(root);
    successful(await invoke(root, ["init"]));
    successful(await invoke(base, ["workspace", "project", "init"]));
    const server = await httpServer(t, base);
    successful(
      await invoke(base, [
        "--server-url",
        server.url,
        "workspace",
        "project",
        "add",
        "alpha",
        root,
      ]),
    );
    const transports = [
      ["--local", "--config", join(root, ".relay/config.json")],
      [
        "--server-url",
        server.url,
        "--project",
        "alpha",
        "--config",
        join(base, "relay.workspace.json"),
      ],
    ];
    const markdown = "## Полный текст\n\n" + "Содержание 世界\n".repeat(600);
    for (let i = 0; i < 2; i++)
      successful(
        await invoke(root, [
          "plan",
          "create",
          "--title",
          `Обзор ${i}`,
          "--goal",
          markdown,
          "--rationale",
          markdown,
          "--participants",
          "Автор",
        ]),
      );
    for (const transport of transports) {
      const run = <T = unknown>(args: (string | number)[]) =>
        invoke<T>(base, [...transport, ...args]);
      const raw = (args: (string | number)[]) =>
        invokeRaw(base, [...transport, ...args], { env: { COLUMNS: "40" } });
      const legacy = successful(
        await run<Page<PlanSummary>>([
          "plan",
          "list",
          "--q",
          "Обзор",
          "--status",
          "draft",
          "--limit",
          1,
        ]),
      );
      assert.equal(legacy.data.items[0]!.goal, markdown);
      assert.equal(legacy.data.items[0]!.rationale, markdown);
      const compact = successful(
        await run<Page<PlanCompact>>([
          "plan",
          "list",
          "--projection",
          "compact",
          "--q",
          "Обзор",
          "--status",
          "draft",
          "--limit",
          1,
        ]),
      );
      assert.equal(compact.data.total, legacy.data.total);
      assert.deepEqual(compact.data.items[0]!.counts, legacy.data.items[0]!.counts);
      for (const key of [
        "goal",
        "rationale",
        "boundaries",
        "expectedResult",
        "result",
        "participants",
        "scope",
      ])
        assert.ok(!(key in compact.data.items[0]!));
      assert.ok(
        Buffer.byteLength(JSON.stringify(compact.data)) <
          Buffer.byteLength(JSON.stringify(legacy.data)) / 10,
      );
      t.diagnostic(
        `${transport.includes("--local") ? "local" : "HTTP"}: data страницы limit=1 — legacy ${Buffer.byteLength(JSON.stringify(legacy.data))} байт, compact ${Buffer.byteLength(JSON.stringify(compact.data))} байт; полные тексты проверены через get.`,
      );
      assert.ok(compact.meta?.page?.nextCursor);
      const next = successful(
        await run<Page<PlanCompact>>(["plan", "list", "--cursor", compact.meta.page.nextCursor]),
      );
      assert.equal(next.data.items.length, 1);
      assert.ok(!("goal" in next.data.items[0]!));
      assert.notEqual(next.data.items[0]!.key, compact.data.items[0]!.key);
      assert.equal(next.meta?.page?.nextCursor, null);
      const mismatch = await run([
        "plan",
        "list",
        "--projection",
        "compact",
        "--cursor",
        legacy.meta!.page!.nextCursor!,
      ]);
      failed(mismatch, "INVALID_CURSOR");
      failed(await run(["plan", "list", "--projection", "typo"]), "VALIDATION_ERROR");
      const overview = human(await raw(["plan", "list", "--projection", "compact", "--limit", 1]));
      const read = commands(overview).find((line) => line.includes("plan get"));
      assert.equal(read, undefined);
      const plan = successful(
        await run<PlanSummary>(["plan", "get", compact.data.items[0]!.key]),
      ).data;
      assert.equal(plan.goal, markdown);
      const before = plan.revision;
      successful(
        await run(["plan", "update", plan.key, "--participants", "Новый", "--if-revision", before]),
      );
      successful(
        await run([
          "plan",
          "update",
          plan.key,
          "--summary",
          "Не трогать участников",
          "--if-revision",
          before + 1,
        ]),
      );
      assert.deepEqual(
        successful(await run<PlanSummary>(["plan", "get", plan.key])).data.participants,
        ["Новый"],
      );
      failed(
        await run([
          "plan",
          "update",
          plan.key,
          "--clear-participants",
          "--participants",
          "Лишний",
          "--if-revision",
          before + 2,
        ]),
        "CONFLICTING_OPTIONS",
      );
      failed(
        await run(["plan", "update", plan.key, "--clear-participants", "--if-revision", before]),
        "REVISION_CONFLICT",
        4,
      );
      successful(
        await run([
          "plan",
          "update",
          plan.key,
          "--clear-participants",
          "--if-revision",
          before + 2,
        ]),
      );
      assert.deepEqual(
        successful(await run<PlanSummary>(["plan", "get", plan.key])).data.participants,
        [],
      );
      failed(
        await run(["plan", "list", "--cursor", compact.meta.page.nextCursor]),
        "PLANNING_CHANGED",
        4,
      );
      const s = successful(
        await run<PlanningSaved>([
          "plan",
          "stage",
          "create",
          plan.key,
          "--title",
          "Этап транспорта",
          "--if-revision",
          before + 3,
        ]),
      ).data;
      const task = successful(
        await run<EntitySaved>(["task", "create", "--board", "product", "--title", "Транспорт"]),
      ).data;
      successful(
        await run([
          "plan",
          "stage",
          "task",
          "add",
          plan.key,
          s.stageId!,
          "--tasks",
          task.key,
          "--if-revision",
          s.revision,
        ]),
      );
      let text = human(await raw(["plan", "get", plan.key]));
      for (const args of [
        ["plan", "stage", "list", plan.key],
        ["plan", "stage", "get", plan.key, s.stageId!],
        ["plan", "stage", "task", "list", plan.key, s.stageId!],
        ["task", "get", task.key],
      ]) {
        assert.deepEqual(commands(text), []);
        text = human(await raw(args));
      }
    }
  },
);

test(
  "PLAN-06/07 + COMMON-DELETE-01: прогресс, done с открытым блокером, запрет closed и удаление после remove local/HTTP",
  { timeout: 180_000 },
  async (t) => {
    const root = await tempDirectory(t);
    successful(await invoke(root, ["init"]));
    const server = await httpServer(t, root);
    for (const transport of [["--local"], ["--server-url", server.url]]) {
      const run = <T = unknown>(args: (string | number)[]) =>
        invoke<T>(root, [...transport, ...args]);
      const raw = (args: (string | number)[]) =>
        invokeRaw(root, [...transport, ...args], { env: { COLUMNS: "40" } });
      const entity = async (args: (string | number)[]) =>
        successful(await run<EntitySaved>(args)).data;
      const save = async (args: (string | number)[]) =>
        successful(await run<PlanningSaved>(args)).data;
      const task = await entity([
        "task",
        "create",
        "--board",
        "product",
        "--title",
        "Убираемая работа",
      ]);
      const plan = await save([
        "plan",
        "create",
        "--title",
        "Пересмотр",
        "--goal",
        "Проверить состав",
      ]);
      const stage = await save([
        "plan",
        "stage",
        "create",
        plan.key,
        "--title",
        "Этап",
        "--if-revision",
        plan.revision,
      ]);
      const included = await save([
        "plan",
        "stage",
        "task",
        "add",
        plan.key,
        stage.stageId!,
        "--tasks",
        task.key,
        "--if-revision",
        stage.revision,
      ]);
      const openRefusal = await run(["task", "delete-preview", task.key]);
      failed(openRefusal, "PLANNING_REFERENCE_IN_USE", 4);
      const removed = await save([
        "plan",
        "stage",
        "task",
        "remove",
        plan.key,
        stage.stageId!,
        "--tasks",
        task.key,
        "--if-revision",
        included.revision,
      ]);
      successful(await run(["task", "get", task.key]));
      const old = successful(
        await run<EntityDeletionPreview>(["task", "delete-preview", task.key]),
      ).data;
      assert.deepEqual(
        old.deleted.map((item) => item.ref.id),
        [task.ref.id],
      );
      await entity([
        "task",
        "update",
        task.key,
        "--title",
        "Изменение",
        "--if-revision",
        task.revision,
      ]);
      failed(
        await run(["task", "delete", task.key, "--if-version", old.version]),
        "REVISION_CONFLICT",
        4,
      );
      const preview = human(await raw(["task", "delete-preview", task.key]));
      const confirm = commands(preview).find((line) => line.includes("task delete "));
      assert.ok(confirm);
      successful(await invoke(root, tokens(confirm)));
      const gone = await run(["task", "get", task.key]);
      assert.equal(gone.body.ok, false);

      const blocker = await entity([
        "task",
        "create",
        "--board",
        "product",
        "--title",
        "Внешняя зависимость",
        "--column",
        "done",
      ]);
      const done = await entity([
        "task",
        "create",
        "--board",
        "product",
        "--title",
        "УникальноеНазваниеЗадачи",
        "--column",
        "done",
        "--dependencies",
        blocker.key,
      ]);
      const composition = await save([
        "plan",
        "stage",
        "task",
        "add",
        plan.key,
        stage.stageId!,
        "--tasks",
        done.key,
        "--if-revision",
        removed.revision,
      ]);
      await save([
        "plan",
        "complete",
        plan.key,
        "--result",
        "Проверено",
        "--if-revision",
        composition.revision,
      ]);
      successful(
        await run([
          "task",
          "move",
          blocker.key,
          "--column",
          "ready",
          "--if-revision",
          blocker.revision,
        ]),
      );
      const current = successful(await run<PlanSummary>(["plan", "get", plan.key])).data;
      assert.equal(current.status, "completed");
      assert.equal(current.counts.blocked, 1);
      assert.equal(current.counts.completed, 0);
      const tasks = human(await raw(["plan", "stage", "task", "list", plan.key, stage.stageId!]));
      assert.match(tasks, /Выполнена:\s*Нет/);
      assert.match(tasks, /Заблокирована:\s*Да/);
      const progress = successful(
        await run<WorkPlanProgress>(["plan", "progress", plan.key, "--limit", 1]),
      );
      assert.equal(progress.data.diverged, true);
      assert.equal(progress.data.counts.blocked, 1);
      const progressText = human(await raw(["plan", "progress", plan.key, "--limit", 20]));
      assert.equal(progressText.split("УникальноеНазваниеЗадачи").length - 1, 1);
      assert.ok(progressText.includes("Причины"));
      assert.doesNotMatch(progressText, /task progress/);
      const membership = human(await raw(["plan", "task", "memberships", done.key]));
      assert.match(membership, /Состояние плана:\s*Завершён/);
      const closed = await run(["task", "delete-preview", done.key]);
      failed(closed, "PLANNING_REFERENCE_IN_USE", 4);
      if (!closed.body.ok) {
        assert.match(closed.body.error.message, /закрыт|Закрыт/);
        const details = closed.body.error.details as {
          status: string;
          editable: boolean;
          stages: { id: string; taskIds: string[] }[];
        };
        assert.equal(details.status, "completed");
        assert.equal(details.editable, false);
        assert.ok(
          details.stages.some(
            (entry) => entry.id === stage.stageId && entry.taskIds.includes(done.ref.id),
          ),
        );
      }
      const blocked = await raw(["task", "delete-preview", done.key]);
      assert.equal(blocked.code, 4);
      assert.match(blocked.stdout.replace(/\s+/g, " "), /штатного.*нет/);
      assert.ok(commands(blocked.stdout).every((line) => !line.includes("task delete ")));

      const feature = await entity([
        "feature",
        "create",
        "--name",
        "Область плана",
        "--description",
        "Сохраняется",
      ]);
      const scoped = await save([
        "plan",
        "create",
        "--title",
        "Отменённая область",
        "--scope",
        feature.key,
      ]);
      const scopeOpen = await run(["feature", "delete-preview", feature.key]);
      failed(scopeOpen, "PLANNING_REFERENCE_IN_USE", 4);
      if (!scopeOpen.body.ok) {
        const details = scopeOpen.body.error.details as { status: string; editable: boolean };
        assert.equal(details.status, "draft");
        assert.equal(details.editable, true);
      }
      await save([
        "plan",
        "cancel",
        scoped.key,
        "--result",
        "Отмена",
        "--if-revision",
        scoped.revision,
      ]);
      const scopeClosed = await run(["feature", "delete-preview", feature.key]);
      failed(scopeClosed, "PLANNING_REFERENCE_IN_USE", 4);
      if (!scopeClosed.body.ok) {
        const details = scopeClosed.body.error.details as {
          status: string;
          editable: boolean;
          scope: { kind: string; id: string }[];
        };
        assert.equal(details.status, "cancelled");
        assert.equal(details.editable, false);
        assert.ok(
          details.scope.some((entry) => entry.kind === "feature" && entry.id === feature.ref.id),
        );
      }
    }
  },
);
