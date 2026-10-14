import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";
import { createLocalBackend } from "@relay/project-runtime/backend/local";
import {
  entityCreateSchema,
  type EntityDeletionPreview,
  type EntityDeleted,
  type EntityDetail,
  type EntitySaved,
} from "@relay/contracts/entities";
import { shellCommand } from "../src/command-kit.js";
import { boardsText } from "../src/presentation/board-tasks.js";
import { deletionPreviewText } from "../src/presentation/entity-deletion.js";
import {
  binary,
  cliEnv,
  cliNodeArgs,
  fixture,
  invoke,
  invokeRaw,
  successful,
  failed,
  tempDirectory,
} from "./helpers/cli.js";
import { httpServer, httpProxy } from "./helpers/http.js";

// Выбираем команды только из известной фикстуры, не из произвольного пользовательского Markdown.
const hints = (text: string) =>
  text.split("\n").filter((line) => line.startsWith("npx @oim-dev/relay-cli "));
const human = (result: Awaited<ReturnType<typeof invokeRaw>>) => {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /\u001b|\[object Object\]/);
  return result.stdout;
};
async function follow(cwd: string, command: string) {
  assert.ok(command.startsWith("npx @oim-dev/relay-cli "), command);
  const result = await promisify(execFile)(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `npx() { shift; ${shellCommand([process.execPath, ...cliNodeArgs, binary])} "$@"; }\n${command}`,
    ],
    { cwd, env: cliEnv({ RELAY_ACTOR: undefined }), timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
  );
  assert.equal(result.stderr, "");
  return result.stdout;
}
async function evidence(t: TestContext, name: string, stdout: string) {
  const commands = hints(stdout);
  const metrics = {
    name,
    bytes: Buffer.byteLength(stdout),
    lines: stdout.split("\n").length - 1,
    commands: commands.length,
    commandBytes: Buffer.byteLength(commands.map((line) => line + "\n").join("")),
  };
  t.diagnostic(JSON.stringify(metrics));
  if (process.env.BOARD_EVIDENCE_DIR) {
    await mkdir(process.env.BOARD_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.BOARD_EVIDENCE_DIR, `${name}.stdout`), stdout);
  }
}
const create = (
  backend: Awaited<ReturnType<typeof createLocalBackend>>,
  data: { kind: string; [key: string]: unknown },
) =>
  backend.entities.create(
    entityCreateSchema.parse({
      data: {
        ...(["feature", "application", "document"].includes(data.kind) ? { summary: "" } : {}),
        ...(data.kind === "application" ? { type: "frontend" } : {}),
        ...(data.kind === "document" ? { documentKind: "description" } : {}),
        ...data,
      },
      requestId: "board-fixture",
    }),
    "board-fixture",
  );

test("board: help и только application deletion без проекта", async (t) => {
  const cwd = await tempDirectory(t);
  const board = human(await invokeRaw(cwd, ["board", "--help"])).replace(/\s+/g, " ");
  for (const fragment of [
    "search --kind board",
    "application create",
    "application update --name",
    "application delete-preview/delete",
    "product overview --metric board-work",
  ])
    assert.ok(board.includes(fragment), board);
  for (const action of ["delete-preview", "delete"]) {
    const help = human(await invokeRaw(cwd, ["application", action, "--help"]));
    assert.match(help, /--if-version/);
    assert.match(help, /Примеры:/);
  }
  for (const kind of ["board", "feature", "scenario", "implementation", "task"])
    failed(
      await invoke(cwd, [kind, "delete", "SOMETHING", "--if-version", "version"]),
      "INVALID_ARGUMENT",
    );
});

test(
  "board: 2/20/18 досок, полные страницы, компактная навигация и 24 задачи отдельно",
  { timeout: 180_000 },
  async (t) => {
    const app = await fixture(t);
    const backend = await createLocalBackend(app.root);
    const apps: EntitySaved[] = [];
    const show = async (name: string, args: Array<string | number>) => {
      for (const width of [40, 100]) {
        const output = human(
          await invokeRaw(app.root, args, { env: { COLUMNS: String(width), FORCE_COLOR: "3" } }),
        );
        await evidence(t, `${name}-${width}`, output);
        assert.equal(hints(output).filter((line) => line.includes("board get ")).length, 1);
        assert.equal(
          hints(output).filter((line) => line.includes("--metric board-work")).length,
          1,
        );
        assert.equal((output.match(/Показано:/g) ?? []).length, 1);
      }
    };
    await show("list2", ["board", "list"]);
    for (let index = 1; index <= 18; index++)
      apps.push(
        await create(backend, {
          kind: "application",
          name: `Очень похожая длинная доска доставки — приложение 東京 🧪 е́ ${index}`,
          slug: `audit-app-${index}`,
          prefix: `AU${String(index).padStart(2, "0")}`,
          description: "## Только приложение\n\nНе печатать в доске.",
        }),
      );
    await show("list20", ["board", "list"]);
    for (const selected of apps.slice(-2)) {
      const preview = successful(
        await app.run<EntityDeletionPreview>(["application", "delete-preview", selected.key]),
      ).data;
      successful(
        await app.run(["application", "delete", selected.key, "--if-version", preview.version]),
      );
    }
    const full = successful(
      await app.run<{ items: { id: string; key: string; slug: string }[]; total: number }>([
        "board",
        "list",
      ]),
    ).data;
    assert.equal(full.total, 18);
    assert.equal(full.items[0]!.slug, "product");
    assert.equal(full.items.at(-1)!.slug, "infrastructure");
    const ids: string[] = [];
    let args: Array<string | number> = ["board", "list", "--limit", 7];
    let pageNumber = 0;
    for (;;) {
      const page = successful(await app.run<typeof full>(args));
      ids.push(...page.data.items.map((item) => item.id));
      await show(`walk18-${++pageNumber}`, args);
      const output = human(await invokeRaw(app.root, args));
      const get = hints(output).find((line) => line.includes("board get "))!;
      assert.ok(get.endsWith(`board get ${page.data.items[0]!.key}`), get);
      assert.match(await follow(app.root, get), /Ревизия/);
      if (!page.meta!.page!.nextCursor) {
        assert.match(output, /Конец списка/);
        assert.equal(hints(output).length, 2);
        break;
      }
      const continued = JSON.parse(await follow(app.root, page.meta!.page!.nextCommand!));
      assert.equal(continued.ok, true);
      args = ["board", "list", "--cursor", page.meta!.page!.nextCursor!];
    }
    assert.equal(pageNumber, 3);
    assert.deepEqual(
      ids,
      full.items.map((item) => item.id),
    );
    assert.equal(new Set(ids).size, 18);
    const first = successful(await app.run(["board", "list", "--limit", 7]));
    await backend.entities.update(
      {
        ref: apps[0]!.key,
        changes: { kind: "application", name: "Новое имя" },
        ifRevision: 1,
        requestId: "rename-name",
      },
      "fixture",
    );
    failed(
      await app.run(["board", "list", "--cursor", first.meta!.page!.nextCursor!]),
      "BOARD_CHANGED",
      4,
    );
    for (let index = 1; index <= 24; index++)
      await create(backend, {
        kind: "task",
        board: "audit-app-7",
        title: `СКРЫТАЯ_ЗАДАЧА_${index}`,
        description: "Содержание только в task get",
      });
    for (const width of [40, 100]) {
      const output = human(
        await invokeRaw(app.root, ["board", "get", "BOARD-AU07"], {
          env: { COLUMNS: String(width) },
        }),
      );
      await evidence(t, `rich24-${width}`, output);
      assert.doesNotMatch(output, /СКРЫТАЯ_ЗАДАЧА|Только приложение/);
      assert.equal(hints(output).length, 2);
      assert.match(await follow(app.root, hints(output)[0]!), /СКРЫТАЯ_ЗАДАЧА_1/);
      const json = successful(
        await app.run(["board", "get", "BOARD-AU07"], { env: { COLUMNS: String(width) } }),
      ).data;
      assert.deepEqual(json, await backend.entities.get({ kind: "board", ref: "BOARD-AU07" }));
    }
    const empty = boardsText(
      { items: [], total: 0, nextOffset: null, version: "empty" },
      { width: 40, color: false },
    );
    assert.match(empty, /досок нет/);
    assert.equal(hints(empty).length, 0);
  },
);

for (const mode of ["local", "http", "workspace"] as const)
  test(
    `board lifecycle ${mode}: owner/rename, полный preview, CAS, внешние ссылки и чтение после удаления`,
    { timeout: 180_000 },
    async (t) => {
      const app = await fixture(t);
      const backend = await createLocalBackend(app.root);
      const selected = await create(backend, {
        kind: "application",
        name: "Приложение 東京 🧪",
        slug: "client",
        prefix: "CLIENT",
        description: "## Владелец\n\nПолное содержание.",
      });
      const feature = await create(backend, {
        kind: "feature",
        name: "Требование",
        description: "Сохранить",
      });
      const scenario = await create(backend, {
        kind: "scenario",
        name: "Сценарий",
        featureId: feature.ref.id,
        description: "Сохранить",
      });
      const fi = await create(backend, {
        kind: "implementation",
        application: selected.key,
        target: feature.key,
        title: "FI",
        description: "Вклад",
      });
      const si = await create(backend, {
        kind: "implementation",
        application: selected.key,
        target: scenario.key,
        title: "SI",
        description: "Вклад сценария",
      });
      const task = await create(backend, {
        kind: "task",
        board: "client",
        title: "Удаляемая задача",
        targets: [fi.key],
      });
      const secondTask = await create(backend, {
        kind: "task",
        board: "client",
        title: "Вторая задача",
      });
      const external = await create(backend, {
        kind: "task",
        board: "product",
        title: "Сохранённый ребёнок",
        parent: task.key,
      });
      const document = await create(backend, {
        kind: "document",
        name: "Сохранённый документ",
        body: "## Документ\n\nСохранить.",
        relations: [
          { target: selected.ref, type: "documents", description: "Снять ссылку, не документ" },
        ],
      });
      const board = await backend.entities.get({ kind: "board", ref: "client" });
      const requests: { method: string; url: string; body?: Record<string, unknown> }[] = [];
      let flags: string[] = [];
      let env: NodeJS.ProcessEnv = {};
      let cwd = app.root;
      let second: Awaited<ReturnType<typeof fixture>> | undefined;
      if (mode === "local") {
        const config = join(app.root, ".relay", "config.json");
        cwd = await tempDirectory(t);
        env = { RELAY_CONFIG: config };
        flags = ["--local"];
      } else {
        let serverRoot = app.root;
        let config: string | undefined;
        if (mode === "workspace") {
          second = await fixture(t);
          serverRoot = join(await tempDirectory(t), "workspace 'доски'");
          await mkdir(serverRoot);
          config = join(serverRoot, "relay.workspace.json");
          await writeFile(
            config,
            JSON.stringify({
              version: 1,
              projects: { a: { path: app.root }, b: { path: second.root } },
            }),
          );
        }
        const server = await httpServer(t, serverRoot);
        const proxy = await httpProxy(t, async (request, response) => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks).toString();
          requests.push({
            method: request.method!,
            url: request.url!,
            ...(body ? { body: JSON.parse(body) } : {}),
          });
          const upstream = await fetch(`${server.url}${request.url}`, {
            method: request.method!,
            ...(body ? { body, headers: { "content-type": "application/json" } } : {}),
          });
          response.writeHead(upstream.status, { "content-type": "application/json" });
          response.end(await upstream.text());
        });
        cwd = await tempDirectory(t);
        env = { RELAY_SERVER_URL: proxy.url, ...(config ? { RELAY_CONFIG: config } : {}) };
        flags = mode === "workspace" ? ["--project", "a"] : [];
      }
      const run = <T = unknown>(args: Array<string | number>, override: NodeJS.ProcessEnv = {}) =>
        invoke<T>(cwd, [...flags, ...args], { env: { ...env, ...override } });
      const text = async (
        args: Array<string | number>,
        width = 100,
        override: NodeJS.ProcessEnv = {},
      ) =>
        human(
          await invokeRaw(cwd, [...flags, ...args], {
            env: { ...env, COLUMNS: String(width), ...override },
          }),
        );
      successful(
        await run([
          "application",
          "rename",
          selected.key,
          "OWNER",
          "--if-revision",
          selected.revision,
        ]),
      );
      const renamed = successful(
        await run<EntitySaved>([
          "board",
          "rename",
          board.key,
          "BOARD-RENAMED",
          "--if-revision",
          board.revision,
          "--request-id",
          "board-rename-id",
        ]),
      ).data;
      assert.deepEqual(renamed.ref, board.ref);
      assert.equal(renamed.revision, board.revision + 1);
      assert.equal(renamed.requestId, "board-rename-id");
      failed(
        await run(["board", "rename", board.key, "BOARD-STALE", "--if-revision", board.revision]),
        "REVISION_CONFLICT",
        4,
      );
      failed(
        await run(["board", "rename", board.key, "PROJECT", "--if-revision", renamed.revision]),
        "ENTITY_KEY_CONFLICT",
        4,
      );
      const current = successful(await run<EntityDetail>(["board", "get", board.key])).data;
      assert.deepEqual(current.data, board.data);
      assert.equal(current.key, renamed.key);
      assert.equal((await backend.entities.get({ kind: "task", ref: task.key })).key, task.key);
      const keys = successful(
        await run<{ aliases: string[] }>(["inspect", "keys", board.key]),
      ).data;
      assert.ok(JSON.stringify(keys).includes(board.key));
      for (const width of [40, 100]) {
        requests.length = 0;
        const output = await text(["board", "get", board.key], width);
        if (mode !== "local") {
          assert.equal(requests.length, 2, JSON.stringify(requests));
          assert.ok(requests[1]!.url.includes("/entities/get"));
        }
        await evidence(t, `${mode}-owner-${width}`, output);
        assert.match(output, /Приложение:\s*OWNER/);
        assert.equal(hints(output).length, 2);
        assert.ok(hints(output).some((line) => line.endsWith("application get OWNER")));
        for (const hint of hints(output)) {
          if (mode !== "local") assert.match(hint, /--server-url/);
          if (mode === "workspace") {
            assert.match(hint, /--project a/);
            assert.match(hint, /--config/);
            assert.ok(hint.includes("'\\''"), hint);
          }
          const next = await follow(cwd, hint);
          assert.match(
            next,
            hint.endsWith("OWNER") ? /application delete-preview OWNER/ : /Удаляемая задача/,
          );
        }
      }
      assert.doesNotMatch(
        await text(["board", "get", "BOARD-PRODUCT"]),
        /Приложение:|application get/,
      );
      requests.length = 0;
      const listing = await text(["board", "list", "--limit", 2]);
      if (mode !== "local") assert.equal(requests.length, 2);
      for (const hint of hints(listing)) assert.ok(await follow(cwd, hint));
      failed(
        await run(["application", "delete-preview", "BOARD-PRODUCT"]),
        "ENTITY_KIND_MISMATCH",
        4,
      );
      const preview = successful(
        await run<EntityDeletionPreview>(["application", "delete-preview", "OWNER"]),
      );
      assert.equal(preview.meta?.page, undefined);
      assert.deepEqual(
        preview.data,
        await backend.deletion.preview({ kind: "application", ref: "OWNER" }),
      );
      assert.deepEqual(
        new Set(preview.data.deleted.map((item) => item.ref.id)),
        new Set(
          [selected, fi, si, task, secondTask].map((item) => item.ref.id).concat(board.ref.id),
        ),
      );
      // Требования сохраняются, но отзываются также их связи с удаляемыми реализациями.
      assert.deepEqual(
        new Set(preview.data.detached.map((item) => item.ref.id)),
        new Set([external.ref.id, document.ref.id, feature.ref.id, scenario.ref.id]),
      );
      const noActor = await text(["application", "delete-preview", "OWNER"], 40, {
        RELAY_ACTOR: undefined,
      });
      assert.match(noActor.replace(/\s+/g, " "), /--actor или RELAY_ACTOR/);
      assert.ok(hints(noActor)[0]!.endsWith("application delete --help"));
      assert.doesNotMatch(noActor, /delete OWNER --if-version/);
      for (const width of [40, 100]) {
        requests.length = 0;
        const output = await text(
          ["application", "delete-preview", "OWNER", "--actor", "board-author"],
          width,
        );
        if (mode !== "local")
          assert.deepEqual(
            requests.map((request) => request.method),
            ["GET", "GET"],
          );
        await evidence(t, `${mode}-preview-${width}`, output);
        assert.ok(output.includes(preview.data.version), output);
        for (const item of [...preview.data.deleted, ...preview.data.detached])
          for (const value of [item.key, item.ref.kind, item.ref.id])
            assert.ok(output.includes(value), output);
        assert.match(output, /Полный каскад удаления/);
        assert.match(output.replace(/\s+/g, " "), /Сохраняемые записи со снятием ссылок/);
        assert.equal(hints(output).length, 1);
        assert.ok(hints(output)[0]!.includes(`--if-version ${preview.data.version}`));
      }
      assert.deepEqual(
        successful(await run<EntityDeletionPreview>(["application", "delete-preview", "OWNER"]))
          .data,
        preview.data,
        "preview не меняет данные",
      );
      failed(
        await run(["application", "delete", "OWNER", "--if-version", preview.data.version], {
          RELAY_ACTOR: undefined,
        }),
        "ACTOR_REQUIRED",
      );
      successful(
        await run([
          "task",
          "comment",
          "add",
          task.key,
          "--title",
          "Обсуждение",
          "--description",
          "Меняет версию удаления",
          "--role",
          "worker",
        ]),
      );
      const stale = await run([
        "application",
        "delete",
        "OWNER",
        "--if-version",
        preview.data.version,
        "--request-id",
        "stale-id",
      ]);
      failed(stale, "REVISION_CONFLICT", 4);
      const staleText = await invokeRaw(
        cwd,
        [...flags, "application", "delete", "OWNER", "--if-version", preview.data.version],
        { env },
      );
      assert.equal(staleText.code, 4, staleText.stdout);
      assert.match(staleText.stdout, /application delete-preview OWNER/);
      assert.doesNotMatch(staleText.stdout, /application delete OWNER --if-version/);
      assert.ok(await backend.entities.get({ kind: "application", ref: "OWNER" }));
      const plan = successful(
        await run<{ key: string; revision: number }>([
          "plan",
          "create",
          "--title",
          "Блокирующий план",
          "--scope",
          "OWNER",
        ]),
      ).data;
      failed(await run(["application", "delete-preview", "OWNER"]), "PLANNING_REFERENCE_IN_USE", 4);
      failed(
        await run(["application", "delete", "OWNER", "--if-version", preview.data.version]),
        "PLANNING_REFERENCE_IN_USE",
        4,
      );
      successful(
        await run(["plan", "update", plan.key, "--clear-scope", "--if-revision", plan.revision]),
      );
      const fresh = successful(
        await run<EntityDeletionPreview>(["application", "delete-preview", "OWNER"]),
      ).data;
      requests.length = 0;
      const receipt = await text(
        [
          "application",
          "delete",
          "OWNER",
          "--if-version",
          fresh.version,
          "--actor",
          "board-author",
          "--request-id",
          "delete-correlation",
        ],
        40,
      );
      await evidence(t, `${mode}-receipt`, receipt);
      if (mode !== "local") {
        assert.deepEqual(
          requests.map((request) => request.method),
          ["GET", "POST"],
        );
        assert.deepEqual(requests[1]!.body, {
          kind: "application",
          ref: "OWNER",
          ifVersion: fresh.version,
          actor: "board-author",
          requestId: "delete-correlation",
        });
      }
      assert.match(receipt, /Каскад удалён/);
      assert.match(receipt, /delete-correlation/);
      assert.equal(hints(receipt).length, 2);
      for (const hint of hints(receipt)) assert.ok(await follow(cwd, hint));
      for (const [kind, ref] of [
        ["application", "OWNER"],
        ["board", renamed.key],
        ["task", task.key],
        ["implementation", fi.key],
      ])
        failed(
          await run([kind!, "get", ref!]),
          kind === "task" ? "NOT_FOUND" : "ENTITY_NOT_FOUND",
          3,
        );
      const survivingTask = await backend.entities.get({ kind: "task", ref: external.key });
      assert.equal(survivingTask.data.kind, "task");
      if (survivingTask.data.kind === "task") assert.equal(survivingTask.data.parentId, null);
      assert.ok(survivingTask.revision > external.revision);
      const survivingDocument = await backend.entities.get({ kind: "document", ref: document.key });
      if (survivingDocument.data.kind !== "document") throw new Error("Ожидался документ");
      assert.deepEqual(survivingDocument.data.relations, []);
      assert.equal((await backend.entities.get({ ref: feature.key })).revision, feature.revision);
      assert.equal((await backend.entities.get({ ref: scenario.key })).revision, scenario.revision);
      const integrity = await run(["doctor", "check"]);
      if (second)
        assert.equal(
          successful(await second.run<{ total: number }>(["board", "list"])).data.total,
          2,
        );
      const other = await create(backend, {
        kind: "application",
        name: "Другая цель",
        slug: "other",
        description: "Квитанция JSON",
      });
      const otherPreview = successful(
        await run<EntityDeletionPreview>(["application", "delete-preview", other.key]),
      ).data;
      const deleted = successful(
        await run<EntityDeleted>([
          "application",
          "delete",
          other.key,
          "--if-version",
          otherPreview.version,
          "--request-id",
          "json-receipt",
        ]),
      ).data;
      assert.deepEqual(deleted, {
        action: "delete",
        ref: other.ref,
        requestId: "json-receipt",
        deleted: 2,
        detached: 0,
        relations: otherPreview.relations,
      });
      const hinted = await create(backend, {
        kind: "application",
        name: "Подтверждение из подсказки",
        slug: "hinted",
        description: "Автор задан окружением",
      });
      const hintText = await text(["application", "delete-preview", hinted.key], 40, {
        RELAY_ACTOR: "cli 'author'",
      });
      requests.length = 0;
      const hintReceipt = await follow(cwd, hints(hintText)[0]!);
      assert.match(hintReceipt, /Каскад удалён/);
      if (mode !== "local") {
        assert.deepEqual(
          requests.map((request) => request.method),
          ["GET", "POST"],
        );
        assert.equal(requests[1]!.body!.actor, "cli 'author'");
        assert.match(String(requests[1]!.body!.requestId), /^[\da-f]{8}-[\da-f-]{27}$/);
      }
      failed(await run(["application", "get", hinted.key]), "ENTITY_NOT_FOUND", 3);
      // Проверка записана сразу после исходного каскада, до последующих мутаций фикстуры.
      successful(integrity);
    },
  );

test("deletion rendering: все 1000+1000 записей и opaque токены без страниц", () => {
  const summary = (index: number, kind: "application" | "document") => ({
    ref: { kind, id: `ID-${kind}-${index}` },
    key: `KEY-${kind}-${index}`,
    title: `Название ${index}`,
    summary: "",
    revision: index,
    status: null,
    active: true,
  });
  const data: EntityDeletionPreview = {
    target: summary(0, "application"),
    version: "version-" + "a".repeat(128),
    deleted: Array.from({ length: 1000 }, (_, index) => summary(index, "application")),
    detached: Array.from({ length: 1000 }, (_, index) => summary(index, "document")),
    relations: 0,
  };
  for (const width of [40, 100]) {
    const text = deletionPreviewText(
      data,
      { width, color: false },
      "npx @oim-dev/relay-cli application delete --help",
      false,
    );
    for (const item of [...data.deleted, ...data.detached]) {
      assert.ok(text.includes(item.key));
      assert.ok(text.includes(item.ref.id));
    }
    assert.ok(text.includes(data.version));
    assert.doesNotMatch(text, /Есть продолжение|Конец списка|Показано:|…/);
    assert.match(text, /Будет отозвано связей:\s*0/);
  }
});
