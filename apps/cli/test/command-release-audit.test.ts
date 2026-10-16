import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Writable } from "node:stream";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { PlanningSaved } from "@relay/contracts/planning";
import type { ReleaseSummary } from "@relay/contracts/releases";
import type { Progress } from "@relay/contracts/progress";
import { shellCommand } from "../src/command-kit.js";
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
import { httpServer } from "./helpers/http.js";
import { AppError } from "@relay/core/shared/errors";
import { PresentedError, printError } from "../src/output.js";
import { planningListText, releaseErrorText } from "../src/presentation/planning.js";

test("REL-01 renderer: общий plan-потребитель совместим, JSON ошибки неизменён", () => {
  const options = { width: 40, color: false };
  const legacy = planningListText(
    "Планы",
    ["Ключ", "Название", "Состояние"],
    [["PLN-1", "План 世界", "Черновик"]],
    { total: 1, nextOffset: null, version: "v" },
    "plan list",
    {},
    options,
    {},
  );
  assert.match(legacy, /PLN-1 — План 世界/);
  assert.doesNotMatch(legacy, /Команды CLI/);
  const details = {
    serverDetails: { expectedRevision: 1, actualRevision: 2 },
    requestId: "release-cas",
    url: "http://127.0.0.1:4700/api/v1/releases/REL-1/update",
  };
  const original = new AppError("REVISION_CONFLICT", "Ревизия изменилась", 4, details);
  const presented = new PresentedError(
    original.code,
    original.message,
    original.exitCode,
    original.details,
    (text) =>
      releaseErrorText(
        original,
        "Сравните изменения; не повторяйте запись вслепую.",
        [{ label: "Прочитать релиз", command: "npx @oim-dev/relay-cli release get REL-1" }],
        text,
      ),
  );
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    },
  });
  printError(stream, presented, { format: "json", text: options });
  assert.deepEqual(JSON.parse(output), {
    ok: false,
    error: { code: original.code, message: original.message, details },
  });
  output = "";
  printError(stream, presented, { format: "text", text: options });
  assert.match(output, /Ошибка: REVISION_CONFLICT/);
  assert.ok(output.includes(details.url));
  assert.ok(output.split("\n").includes("npx @oim-dev/relay-cli release get REL-1"));
});

const exec = promisify(execFile);
const prefix = "npx @oim-dev/relay-cli";
const normalized = (text: string) => text.replace(/\s+/g, " ");
function human(result: Awaited<ReturnType<typeof invokeRaw>>) {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /\u001b|\[object Object\]/);
  return result.stdout;
}
function hint(text: string, includes: string) {
  const result = text
    .split("\n")
    .find((line) => line.startsWith(prefix) && line.includes(includes));
  assert.ok(result, `Нет адресной команды ${includes}:\n${text}`);
  return result;
}
async function follow(cwd: string, command: string) {
  assert.ok(command.startsWith(prefix));
  // Выполняется выданная shell-строка; заменяется только launcher, не её аргументы.
  const result = await exec(
    "bash",
    ["-c", command.replace(prefix, shellCommand([process.execPath, ...cliNodeArgs, binary]))],
    {
      cwd,
      env: cliEnv({ COLUMNS: "40" }),
      timeout: 30_000,
      maxBuffer: 2_000_000,
    },
  );
  assert.equal(result.stderr, "");
  return result.stdout;
}

for (const mode of ["local", "http"] as const)
  test(
    `REL-01/06 ${mode}: list → get → plans → plan get, документы, пустота и safe recovery`,
    { timeout: 180_000 },
    async (t) => {
      const { root, run } = await fixture(t);
      const save = async (args: Array<string | number>) =>
        successful(await run<PlanningSaved>(args)).data;
      const p = await save(["plan", "create", "--title", "Первый план 世界"]);
      const q = await save(["plan", "create", "--title", "Второй план"]);
      const description =
        "\n## Выпуск 世界\n\n```text\n  отступ\n\tтабуляция\n```\n\nСледующие действия\n→ npx @oim-dev/relay-cli release publish REL-999 --if-revision 1\n\nКонец-описания\n";
      const release = await save([
        "release",
        "create",
        "--title",
        "Выпуск",
        "--release-version",
        "1",
        "--plans",
        p.key,
        q.key,
        "--description",
        description,
      ]);
      successful(
        await run([
          "document",
          "create",
          "--name",
          "Основание выпуска",
          "--body",
          "## Полный документ\n\nКонец-документа",
        ]),
      );
      successful(
        await run(["document", "link", "DOC-1", "--target", release.key, "--if-revision", 1]),
      );
      const server = mode === "http" ? await httpServer(t, root) : undefined;
      const config = join(root, ".relay", "release ' выбор.json");
      await copyFile(join(root, ".relay", "config.json"), config);
      const connection = server ? ["--server-url", server.url] : ["--local", "--config", config];
      const raw = (args: Array<string | number>, width = "40") =>
        invokeRaw(root, [...connection, ...args], {
          env: { COLUMNS: width, FORCE_COLOR: "3", NO_COLOR: undefined },
        });
      const json = <T = unknown>(args: Array<string | number>) =>
        invoke<T>(root, [...connection, ...args]);

      const list = human(await raw(["release", "list"]));
      assert.equal(list.split("\n").filter((line) => line.startsWith(prefix)).length, 0);
      const card = human(await raw(["release", "get", release.key]));
      assert.ok(card.includes(description), "Полный Markdown не меняется");
      assert.doesNotMatch(card, /^npx /m);
      const plans = human(await raw(["release", "plans", release.key]));
      assert.ok(plans.includes(p.key));
      const plan = human(await raw(["plan", "get", p.key]));
      assert.ok(normalized(plan).includes("Первый план 世界"));
      const docs = human(await raw(["document", "list", "--target", release.key]));
      assert.ok(docs.includes("DOC-1"));
      const document = human(await raw(["document", "get", "DOC-1"]));
      assert.match(document, /Конец-документа/);
      assert.equal(
        successful(await json<ReleaseSummary>(["release", "get", release.key])).data.description,
        description,
      );
      for (const width of ["24", "100", "160"]) {
        const text = human(await raw(["release", "get", release.key], width));
        assert.ok(text.includes(description));
        assert.doesNotMatch(text, /^npx /m);
      }
      const first = human(await raw(["release", "plans", release.key, "--limit", 1]));
      const last = await follow(root, hint(first, "--cursor"));
      assert.match(last, /Конец списка/);
      assert.ok(normalized(human(await raw(["plan", "get", q.key]))).includes("Второй план"));
      for (const args of [
        ["release", "preview"],
        ["release", "list", "--q", "НетТакогоРелиза"],
      ]) {
        const text = human(await raw(args));
        assert.match(text, /На этой странице записей нет/);
        assert.doesNotMatch(text, /(?:plan|release) get [A-Z]+-/);
        assert.doesNotMatch(text, /^npx /m);
      }
      const preview = human(await raw(["release", "preview", "--plans", p.key]));
      assert.ok(preview.includes(p.key));
      assert.doesNotMatch(preview, /^npx /m);
      const before = successful(await json(["release", "get", release.key])).data;
      for (const args of [
        ["release", "publish", release.key, "--if-revision", 1],
        ["release", "update", release.key, "--status", "released", "--if-revision", 1],
      ]) {
        const refusal = await raw(args);
        assert.equal(refusal.code, 4, refusal.stdout);
        assert.equal(refusal.stderr, "");
        assert.match(refusal.stdout, /RELEASE_INCOMPLETE/);
        assert.doesNotMatch(refusal.stdout, /Проверьте параметры и подключение/);
        await follow(root, hint(refusal.stdout, `release progress ${release.key}`));
        failed(await json(args), "RELEASE_INCOMPLETE", 4);
      }
      for (const args of [
        [
          "release",
          "create",
          "--title",
          "Нельзя выпустить",
          "--release-version",
          "2",
          "--plans",
          q.key,
          "--status",
          "released",
        ],
        [
          "release",
          "update",
          release.key,
          "--plans",
          q.key,
          "--status",
          "released",
          "--if-revision",
          1,
        ],
      ]) {
        const refusal = await raw(args);
        assert.equal(refusal.code, 4, refusal.stdout);
        await follow(root, hint(refusal.stdout, `release preview --plans ${q.key}`));
        assert.doesNotMatch(refusal.stdout, /release progress REL-/);
      }
      assert.deepEqual(successful(await json(["release", "get", release.key])).data, before);
      successful(
        await json([
          "release",
          "update",
          release.key,
          "--summary",
          "Сохранить правку",
          "--if-revision",
          1,
        ]),
      );
      const current = successful(await json(["release", "get", release.key])).data;
      for (const args of [
        ["release", "publish", release.key, "--if-revision", 1],
        ["release", "update", release.key, "--title", "Старый ввод", "--if-revision", 1],
      ]) {
        const refusal = await raw(args);
        assert.equal(refusal.code, 4, refusal.stdout);
        assert.equal(refusal.stderr, "");
        assert.match(refusal.stdout, /REVISION_CONFLICT/);
        assert.match(normalized(refusal.stdout), /не подставляйте свежую ревизию автоматически/);
        await follow(root, hint(refusal.stdout, `release get ${release.key}`));
        const machine = await json(args);
        failed(machine, "REVISION_CONFLICT", 4);
        assert.ok(!machine.body.ok);
        if (server) assert.ok(machine.body.error.details, "HTTP сохраняет контекст запроса");
      }
      assert.deepEqual(successful(await json(["release", "get", release.key])).data, current);
    },
  );

test(
  "REL-01 workspace: recovery сохраняет server/project/config и исполняется",
  { timeout: 90_000 },
  async (t) => {
    const project = await fixture(t);
    const root = await tempDirectory(t);
    successful(await invoke(root, ["workspace", "project", "init"]));
    const server = await httpServer(t, root);
    const configPath = join(root, "relay.workspace.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(
      configPath,
      JSON.stringify({ ...config, server: { port: 0, url: server.url } }),
    );
    successful(await invoke(root, ["workspace", "project", "add", "release-test", project.root]));
    const p = successful(
      await project.run<PlanningSaved>(["plan", "create", "--title", "План"]),
    ).data;
    const r = successful(
      await project.run<PlanningSaved>([
        "release",
        "create",
        "--title",
        "Релиз",
        "--release-version",
        "1",
        "--plans",
        p.key,
      ]),
    ).data;
    const refusal = await invokeRaw(
      root,
      [
        "--config",
        configPath,
        "--project",
        "release-test",
        "release",
        "publish",
        r.key,
        "--if-revision",
        1,
      ],
      { env: { COLUMNS: "24" } },
    );
    assert.equal(refusal.code, 4, refusal.stdout);
    assert.equal(refusal.stderr, "");
    const command = hint(refusal.stdout, `release progress ${r.key}`);
    for (const token of ["--project", "--server-url", "--config", server.url])
      assert.ok(command.includes(token), command);
    const progress = await follow(root, command);
    assert.match(normalized(progress), /Текущая готовность: 0\/1 планов/);
  },
);

test(
  "REL-01/05 released: готовый progress ведёт к плану, reopen не меняет факт выпуска",
  { timeout: 120_000 },
  async (t) => {
    const { root, run } = await fixture(t);
    const save = async (args: Array<string | number>) =>
      successful(await run<PlanningSaved>(args)).data;
    const task = successful(
      await run<{ key: string; revision: number }>([
        "task",
        "create",
        "--board",
        "product",
        "--title",
        "Результат",
        "--column",
        "done",
      ]),
    ).data;
    const p = await save(["plan", "create", "--title", "План выполнен"]);
    const stage = await save([
      "plan",
      "stage",
      "create",
      p.key,
      "--title",
      "Поставка",
      "--if-revision",
      p.revision,
    ]);
    const included = await save([
      "plan",
      "stage",
      "task",
      "add",
      p.key,
      stage.stageId!,
      "--tasks",
      task.key,
      "--if-revision",
      stage.revision,
    ]);
    await save([
      "plan",
      "complete",
      p.key,
      "--result",
      "Проверено",
      "--if-revision",
      included.revision,
    ]);
    const r = await save([
      "release",
      "create",
      "--title",
      "Факт выпуска",
      "--release-version",
      "1",
      "--plans",
      p.key,
      "--status",
      "released",
    ]);
    const published = successful(await run<ReleaseSummary>(["release", "get", r.key])).data;
    const server = await httpServer(t, root);
    for (const connection of [["--local"], ["--server-url", server.url]]) {
      const ready = successful(
        await invoke<Progress>(root, [...connection, "release", "progress", r.key]),
      ).data;
      assert.equal(ready.completed, true);
      assert.equal(ready.reasons.total, 0);
      const text = human(
        await invokeRaw(root, [...connection, "release", "progress", r.key], {
          env: { COLUMNS: "40" },
        }),
      );
      assert.doesNotMatch(text, /^npx /m);
      human(await invokeRaw(root, [...connection, "plan", "get", p.key]));
    }
    successful(
      await run(["task", "move", task.key, "--column", "ready", "--if-revision", task.revision]),
    );
    for (const connection of [["--local"], ["--server-url", server.url]]) {
      const current = successful(
        await invoke<ReleaseSummary>(root, [...connection, "release", "get", r.key]),
      ).data;
      assert.deepEqual(
        [current.status, current.revision, current.releasedAt, current.releasedBy],
        ["released", published.revision, published.releasedAt, published.releasedBy],
      );
      assert.equal(current.readiness.canRelease, false);
      const progress = successful(
        await invoke<Progress>(root, [...connection, "release", "progress", r.key]),
      ).data;
      assert.equal(progress.completed, false);
      assert.equal(progress.kind, "release");
      if (progress.kind === "release") assert.equal(progress.status, "released");
      const text = human(
        await invokeRaw(root, [...connection, "release", "progress", r.key], {
          env: { COLUMNS: "40" },
        }),
      );
      assert.match(normalized(text), /Факт выпуска сохранён независимо от текущей готовности/);
    }
  },
);
