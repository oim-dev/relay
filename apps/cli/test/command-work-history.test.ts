import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { test } from "node:test";
import type {
  WorkCheckpoint,
  WorkContext,
  WorkHistoryMutation,
  WorkHistoryPage,
  WorkOpenIntentsPage,
  WorkSession,
  WorkSessionDetail,
  WorkSessionsPage,
  WorkTreePage,
} from "@relay/contracts/work-history";
import {
  failed,
  binary,
  cliEnv,
  cliNodeArgs,
  fixture,
  invoke,
  invokeRaw,
  successful,
  tempDirectory,
  type RunOptions,
} from "./helpers/cli.js";
import { httpServer } from "./helpers/http.js";

const markdown =
  "\n\n## Поручение 世界\n\n\n  Отступ  \n\n```ts\n\tconst sample = '  точно  ';\n  // длинная строка: " +
  "код".repeat(100) +
  "\n```\n\nПоследняя строка  \n\n";
function human(result: Awaited<ReturnType<typeof invokeRaw>>, fragments: string[]) {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /\x1b|"ok"\s*:|\[object Object\]/);
  for (const text of fragments)
    assert.ok(result.stdout.includes(text), `Нет ${text}:\n${result.stdout}`);
  return result.stdout;
}

const hints = (text: string) =>
  text.split("\n").filter((line) => line.startsWith("npx @oim-dev/relay-cli"));
async function executeHint(cwd: string, command: string) {
  const launcher = `function npx() { shift; "$NODE_BIN" ${cliNodeArgs.map((arg) => `'${arg}'`).join(" ")} "$CLI_BIN" "$@"; };\n`;
  return promisify(execFile)("bash", ["--noprofile", "--norc", "-c", launcher + command], {
    cwd,
    // Намеренно не переносим env исходного вызова: адрес должен сохраниться в самой подсказке.
    env: cliEnv({ NODE_BIN: process.execPath, CLI_BIN: binary }),
    timeout: 30_000,
  });
}

test(
  "work history F1: ошибочный open читает ветку; missing refs ведут к поиску, copied hints исполняются local/HTTP",
  { timeout: 120_000 },
  async (t) => {
    const base = await tempDirectory(t);
    const project = join(base, "база 'с пробелом'");
    const client = join(base, "пустой клиент");
    await mkdir(project);
    await mkdir(client);
    successful(await invoke(project, ["init"]));
    const config = join(project, ".relay/config.json");
    const start = successful(
      await invoke<WorkHistoryMutation>(project, [
        "session",
        "start",
        "--title",
        "Владелец конфликтной записи",
      ]),
    ).data;
    const opened = successful(
      await invoke<WorkHistoryMutation>(project, [
        "checkpoint",
        "open",
        start.session.key,
        "--run",
        start.run!.id,
        "--if-revision",
        start.session.revision,
        "--title",
        "Существующее намерение",
        "--body",
        markdown,
      ]),
    ).data;
    const projectId = successful(await invoke<{ ref: { id: string } }>(project, ["project", "get"]))
      .data.ref.id;
    const server = await httpServer(t, project);
    for (const [prefix, env] of [
      [["--local", "--config", config, "--actor", "chosen-agent"], {}],
      [["--local", "--actor", "chosen-agent"], { RELAY_CONFIG: config }],
      [
        [
          "--server-url",
          server.url,
          "--project",
          projectId,
          "--config",
          config,
          "--actor",
          "chosen-agent",
        ],
        {},
      ],
      [
        ["--project", projectId, "--actor", "chosen-agent"],
        { RELAY_CONFIG: config, RELAY_SERVER_URL: server.url },
      ],
    ] as const) {
      const options = { env: { ...env, COLUMNS: "24", FORCE_COLOR: "3" } };
      const cases = [
        {
          args: [
            "checkpoint",
            "open",
            start.session.key,
            "--run",
            start.run!.id,
            "--if-revision",
            start.session.revision,
            "--title",
            "Не сохранять",
            "--body",
            "Устаревшее намерение",
          ],
          code: "REVISION_CONFLICT",
          expected: "session get",
          marker: start.session.key,
        },
        {
          args: ["session", "get", "S-00000000000000000000000000000000"],
          code: "ENTITY_NOT_FOUND",
          expected: "session list",
          marker: start.session.key,
        },
        {
          args: ["checkpoint", "get", "CP-00000000000000000000000000000000"],
          code: "ENTITY_NOT_FOUND",
          expected: "session history --kind checkpoint",
          marker: opened.checkpoint!.key,
        },
      ];
      for (const scenario of cases) {
        const error = await invokeRaw(client, [...prefix, ...scenario.args], options);
        assert.notEqual(error.code, 0, error.stdout);
        assert.equal(error.stderr, "");
        assert.ok(error.stdout.includes(scenario.code), error.stdout);
        assert.doesNotMatch(error.stdout, /\x1b/);
        const commands = hints(error.stdout);
        assert.equal(commands.length, 1, error.stdout);
        assert.ok(commands[0]!.includes(scenario.expected), commands[0]);
        assert.ok(commands[0]!.includes("--config"), commands[0]);
        assert.ok(commands[0]!.includes("--actor chosen-agent"), commands[0]);
        if (prefix.some((value) => value === "--project")) {
          assert.ok(commands[0]!.includes(`--project ${projectId}`), commands[0]);
          assert.ok(commands[0]!.includes(`--server-url ${server.url}`), commands[0]);
        } else assert.ok(commands[0]!.includes("--local"), commands[0]);
        const followed = await executeHint(client, commands[0]!);
        assert.equal(followed.stderr, "");
        assert.ok(followed.stdout.includes(scenario.marker), followed.stdout);
        assert.doesNotMatch(followed.stdout, /ENTITY_NOT_FOUND|REVISION_CONFLICT|\x1b/);
      }
      // Адрес CP при branch-CAS может сначала вести к checkpoint, но оттуда доступна правильная ветка.
      const saveConflict = await invokeRaw(
        client,
        [
          ...prefix,
          "checkpoint",
          "save",
          opened.checkpoint!.key,
          "--run",
          start.run!.id,
          "--if-revision",
          start.session.revision,
          "--title",
          "Не сохранять",
          "--body",
          "Устаревший материал",
        ],
        options,
      );
      assert.ok(saveConflict.stdout.includes("REVISION_CONFLICT"), saveConflict.stdout);
      const command = hints(saveConflict.stdout)[0]!;
      let followed = await executeHint(client, command);
      if (command.includes("checkpoint get")) {
        assert.ok(followed.stdout.includes(start.session.id));
        followed = await invokeRaw(
          client,
          [...prefix, "session", "get", start.session.key],
          options,
        );
      } else assert.ok(command.includes("session get"), command);
      assert.ok(followed.stdout.includes(start.session.key), followed.stdout);
    }
    const after = successful(
      await invoke<WorkSessionDetail>(project, ["session", "get", start.session.key]),
    ).data;
    assert.deepEqual(
      after.session,
      opened.session,
      "Подсказки только читают, конфликт не повторяет мутацию",
    );
    assert.equal(after.counts.checkpoints, 1);
  },
);

test(
  "work history F2: все публичные ключи копируются вне hints при 24/40/100/160, Markdown не меняется",
  { timeout: 120_000 },
  async (t) => {
    const { root, run } = await fixture(t);
    const save = async (args: Array<string | number>) =>
      successful(await run<WorkHistoryMutation>(args)).data;
    const start = await save([
      "session",
      "start",
      "--title",
      "Длинное название корневого поручения с отдельным переносом",
      "--description",
      markdown,
    ]);
    let parent = start.session;
    const opened = await save([
      "checkpoint",
      "open",
      parent.key,
      "--run",
      start.run!.id,
      "--if-revision",
      parent.revision,
      "--title",
      "Длинное название исходного намерения",
      "--body",
      markdown,
    ]);
    parent = opened.session;
    const fork = await save([
      "session",
      "fork",
      opened.checkpoint!.key,
      "--run",
      start.run!.id,
      "--if-revision",
      parent.revision,
      "--title",
      "Дочернее поручение для проверки ключей",
    ]);
    parent = fork.session;
    const child = await save([
      "session",
      "attach",
      fork.childSession!.key,
      "--if-revision",
      fork.childSession!.revision,
    ]);
    const known = new Set([
      parent.key,
      start.run!.key,
      opened.checkpoint!.key,
      child.session.key,
      child.run!.key,
    ]);
    const branchKeys = [parent.key, child.session.key];
    const checkpointKeys = [opened.checkpoint!.key];
    function check(text: string, expected: string[]) {
      assert.doesNotMatch(text, /\x1b/);
      const content = text
        .split("\n")
        .filter((line) => !line.startsWith("npx @oim-dev/relay-cli"))
        .join("\n");
      for (const key of expected)
        assert.ok(content.includes(key), `Разорван или отсутствует ${key}:\n${content}`);
      for (const [token] of content.matchAll(/\b(?:S|RUN|CP)-[A-Za-z0-9._-]+/g))
        assert.ok(
          known.has(token),
          `Фрагмент вместо полного публичного ключа ${token}:\n${content}`,
        );
    }
    for (const width of [24, 40, 100, 160]) {
      const options = { env: { COLUMNS: String(width), FORCE_COLOR: "3" } };
      const receipt = human(
        await invokeRaw(
          root,
          [
            "checkpoint",
            "save",
            opened.checkpoint!.key,
            "--run",
            start.run!.id,
            "--if-revision",
            parent.revision,
            "--title",
            `Материал ширины ${width}`,
            "--body",
            markdown,
          ],
          options,
        ),
        [],
      );
      parent = successful(await run<WorkSessionDetail>(["session", "get", parent.key])).data
        .session;
      const progress = successful(
        await run<WorkHistoryPage>([
          "session",
          "history",
          parent.key,
          "--kind",
          "checkpoint",
          "--limit",
          1,
        ]),
      ).data.items[0]!;
      assert.equal(progress.kind, "checkpoint");
      if (progress.kind !== "checkpoint") throw new Error("Ожидалась новая точка");
      known.add(progress.checkpoint.key);
      checkpointKeys.push(progress.checkpoint.key);
      check(receipt, [parent.key, start.run!.key, progress.checkpoint.key]);
      const childTitle = `Поручение ширины ${width}`;
      const forkReceipt = human(
        await invokeRaw(
          root,
          [
            "session",
            "fork",
            opened.checkpoint!.key,
            "--run",
            start.run!.id,
            "--if-revision",
            parent.revision,
            "--title",
            childTitle,
          ],
          options,
        ),
        [],
      );
      parent = successful(await run<WorkSessionDetail>(["session", "get", parent.key])).data
        .session;
      const newChild = successful(
        await run<WorkSessionsPage>(["session", "list", "--q", childTitle]),
      ).data.items[0]!;
      known.add(newChild.key);
      branchKeys.push(newChild.key);
      check(forkReceipt, [parent.key, start.run!.key, newChild.key]);
      const reads: [string[], string[], boolean][] = [
        [
          ["session", "list", "--limit", "100"],
          [...branchKeys, start.run!.key, child.run!.key],
          false,
        ],
        [
          ["session", "tree", parent.key, "--limit", "100"],
          [...branchKeys, start.run!.key, child.run!.key],
          false,
        ],
        [["session", "intents", parent.key], [opened.checkpoint!.key], false],
        [["session", "get", parent.key], [parent.key, start.run!.key], true],
        [["checkpoint", "get", opened.checkpoint!.key], [opened.checkpoint!.key], true],
        [
          ["session", "history", parent.key, "--include-children", "--limit", "100"],
          [...known],
          false,
        ],
        [
          ["session", "context", parent.key, "--limit", "100"],
          [...branchKeys, ...checkpointKeys, start.run!.key],
          true,
        ],
      ];
      for (const [args, expected, fullMarkdown] of reads) {
        const output = human(await invokeRaw(root, args, options), fullMarkdown ? [markdown] : []);
        check(output, expected);
        // Полные страницы не повторяют навигацию; адреса остаются в данных.
        if (args[1] === "list" || args[1] === "tree") assert.equal(hints(output).length, 0);
      }
    }
    parent = (
      await save([
        "session",
        "pause",
        parent.key,
        "--run",
        start.run!.id,
        "--if-revision",
        parent.revision,
        "--reason",
        "Проверить последнее участие",
      ])
    ).session;
    for (const width of [24, 40, 100, 160]) {
      const output = human(
        await invokeRaw(root, ["session", "get", parent.key], { env: { COLUMNS: String(width) } }),
        [markdown],
      );
      check(output, [parent.key, start.run!.key]);
    }
  },
);

for (const transport of ["local", "HTTP"] as const) {
  test(
    `work history ${transport}: полный цикл, вложенные ветки, принятие, Markdown, страницы и смена участия`,
    { timeout: 240_000 },
    async (t) => {
      const { root } = await fixture(t);
      const server = transport === "HTTP" ? await httpServer(t, root) : undefined;
      const prefix = server ? ["--server-url", server.url] : ["--local"];
      const run = <T>(args: Array<string | number>, options?: RunOptions) =>
        invoke<T>(root, [...prefix, ...args], options);
      const text = (args: Array<string | number>, width = 40) =>
        invokeRaw(root, [...prefix, ...args], {
          env: { COLUMNS: String(width), FORCE_COLOR: "3" },
        });
      const save = async (args: Array<string | number>, options?: RunOptions) =>
        successful(await run<WorkHistoryMutation>(args, options)).data;
      const read = async (session: WorkSession) =>
        successful(await run<WorkSessionDetail>(["session", "get", session.key])).data;
      const owner = (session: WorkSession) => [
        "--if-revision",
        session.revision,
        "--run",
        session.currentRunId!,
      ];
      const file = join(root, "полный материал.md");
      await writeFile(file, markdown);

      const empty = successful(await run<WorkSessionsPage>(["session", "list", "--unfinished"]));
      assert.equal(empty.meta?.page?.total, 0);
      assert.equal(empty.meta?.page?.nextCursor, null);
      assert.deepEqual(
        hints(human(await text(["session", "list"]), ["В этой выборке веток нет"])),
        [],
      );
      const start = await save(
        [
          "session",
          "start",
          "--title",
          "Основное поручение 世界",
          "--description-file",
          file,
          "--reason-file",
          "-",
          "--client",
          "test",
          "--source-session-id",
          "external-1",
        ],
        { input: markdown },
      );
      let parent = start.session;
      assert.equal(start.run?.id, parent.currentRunId);
      assert.equal(start.run?.reason, markdown);
      assert.equal(start.run?.sourceSessionId, "external-1");
      assert.equal((await read(parent)).session.description, markdown);
      for (const width of [24, 40, 100, 160])
        human(await text(["session", "get", parent.key], width), [
          markdown,
          parent.key,
          parent.currentRunId!,
        ]);

      const opened = await save(
        [
          "checkpoint",
          "open",
          parent.key,
          ...owner(parent),
          "--title",
          "Намерение родителя",
          "--body-file",
          "-",
          "--done-file",
          file,
          "--remaining",
          markdown,
          "--next-step",
          markdown,
          "--checks",
          markdown,
          "--references",
          "PROJECT",
        ],
        { input: markdown },
      );
      parent = opened.session;
      assert.ok(opened.checkpoint);
      const intent = opened.checkpoint;
      assert.equal(intent.kind, "intent");
      assert.equal(intent.summary, "", "summary не выводится из body");
      const cp = successful(await run<WorkCheckpoint>(["checkpoint", "get", intent.key])).data;
      for (const field of ["body", "done", "remaining", "nextStep", "checks"] as const)
        assert.equal(cp[field], markdown);
      assert.equal(cp.references[0]?.key, "PROJECT");
      human(await text(["checkpoint", "get", intent.key]), [
        markdown,
        "PROJECT",
        "Сохранённые подписи ссылок",
        parent.id,
        start.run!.id,
      ]);

      const forked = await save([
        "session",
        "fork",
        intent.key,
        ...owner(parent),
        "--title",
        "Дочернее поручение",
        "--description",
        markdown,
      ]);
      parent = forked.session;
      let child = forked.childSession!;
      assert.equal(child.status, "pending");
      assert.equal(child.currentRunId, null);
      assert.equal(child.parentSessionId, parent.id);
      assert.equal(child.originCheckpointId, intent.id);
      child = (
        await save([
          "session",
          "attach",
          child.key,
          "--if-revision",
          child.revision,
          "--actor",
          "child-agent",
          "--reason",
          markdown,
        ])
      ).session;
      const childOpen = await save([
        "checkpoint",
        "open",
        child.key,
        ...owner(child),
        "--title",
        "Вложенное намерение",
        "--body",
        markdown,
        "--actor",
        "child-agent",
      ]);
      child = childOpen.session;
      const childIntent = childOpen.checkpoint!;
      const nested = await save([
        "session",
        "fork",
        childIntent.key,
        ...owner(child),
        "--title",
        "Внук",
        "--description",
        markdown,
        "--actor",
        "child-agent",
      ]);
      child = nested.session;
      let grandchild = nested.childSession!;
      grandchild = (
        await save([
          "session",
          "attach",
          grandchild.key,
          "--if-revision",
          grandchild.revision,
          "--actor",
          "grandchild-agent",
        ])
      ).session;

      const intents = successful(
        await run<WorkOpenIntentsPage>([
          "session",
          "intents",
          parent.key,
          "--include-children",
          "--limit",
          1,
        ]),
      );
      assert.equal(intents.data.total, 2);
      assert.equal(intents.data.items[0]?.id, intent.id);
      assert.equal(intents.data.items[0]?.body, markdown);
      const intents2 = successful(
        await run<WorkOpenIntentsPage>([
          "session",
          "intents",
          parent.key,
          "--cursor",
          intents.meta!.page!.nextCursor!,
        ]),
      );
      assert.equal(intents2.data.items[0]?.id, childIntent.id);
      assert.equal(intents2.meta!.page!.nextCursor, null);
      const ownIntents = successful(
        await run<WorkOpenIntentsPage>(["session", "intents", parent.key]),
      );
      assert.equal(ownIntents.data.total, 1);
      human(await text(["session", "intents", parent.key]), [intent.key, "Намерение родителя"]);
      failed(
        await run([
          "session",
          "intents",
          parent.key,
          "--include-children",
          "false",
          "--cursor",
          intents.meta!.page!.nextCursor!,
        ]),
        "INVALID_CURSOR",
      );
      const firstTree = successful(
        await run<WorkTreePage>(["session", "tree", parent.key, "--limit", 1]),
      );
      assert.deepEqual(firstTree.data.totals, {
        sessions: 3,
        unfinished: 3,
        runs: 3,
        checkpoints: 2,
        openIntents: 2,
      });
      let treeCursor = firstTree.meta!.page!.nextCursor;
      const nodes = [...firstTree.data.items];
      while (treeCursor) {
        const page = successful(
          await run<WorkTreePage>(["session", "tree", parent.key, "--cursor", treeCursor]),
        );
        assert.deepEqual(page.data.totals, firstTree.data.totals);
        nodes.push(...page.data.items);
        human(await text(["session", "tree", parent.key, "--cursor", treeCursor]), [
          "Вне этой страницы",
          "Глубина",
          "Всего веток поддерева",
        ]);
        treeCursor = page.meta!.page!.nextCursor;
      }
      assert.deepEqual(
        nodes.map((node) => [node.session.id, node.depth, node.parentSessionId]),
        [
          [parent.id, 0, null],
          [child.id, 1, parent.id],
          [grandchild.id, 2, child.id],
        ],
      );
      failed(
        await run(["session", "tree", child.key, "--cursor", firstTree.meta!.page!.nextCursor!]),
        "INVALID_CURSOR",
      );
      const list = successful(
        await run<WorkSessionsPage>(["session", "list", "--unfinished", "--limit", 1]),
      );
      assert.equal(list.meta!.page!.total, 3);
      assert.ok(list.meta!.page!.nextCommand!.includes("--unfinished true"));
      if (server) assert.ok(list.meta!.page!.nextCommand!.includes(server.url));
      else assert.ok(list.meta!.page!.nextCommand!.includes("--local"));
      const list2 = successful(
        await run<WorkSessionsPage>(["session", "list", "--cursor", list.meta!.page!.nextCursor!]),
      );
      assert.equal(list2.meta!.page!.limit, 1);
      assert.equal(list2.meta!.page!.total, 3);
      failed(
        await run([
          "session",
          "list",
          "--unfinished",
          "false",
          "--cursor",
          list.meta!.page!.nextCursor!,
        ]),
        "INVALID_CURSOR",
      );
      const byActor = successful(
        await run<WorkSessionsPage>([
          "session",
          "list",
          "--actor-filter",
          "child-agent",
          "--parent",
          parent.key,
          "--status",
          "open",
          "--q",
          "Дочернее",
        ]),
      );
      assert.deepEqual(
        byActor.data.items.map((item) => item.id),
        [child.id],
      );
      const roots = successful(
        await run<WorkSessionsPage>(["session", "list", "--parent", "null"]),
      );
      assert.deepEqual(byActor.data.projectTotals, firstTree.data.totals);
      assert.equal(byActor.data.items[0]?.counts.runs, 1);
      assert.equal(byActor.data.items[0]?.latestRun?.actor, "child-agent");
      assert.deepEqual(
        roots.data.items.map((item) => item.id),
        [parent.id],
      );

      const paused = await save([
        "session",
        "pause",
        parent.key,
        ...owner(parent),
        "--reason-file",
        file,
      ]);
      parent = paused.session;
      assert.equal(parent.status, "paused");
      assert.equal(paused.run?.endSummary, markdown);
      assert.equal(paused.run?.reason, markdown);
      const resumed = await save(
        ["session", "resume", parent.key, "--if-revision", parent.revision, "--reason-file", "-"],
        { input: markdown },
      );
      parent = resumed.session;
      assert.equal(resumed.run?.predecessorRunId, start.run!.id);
      const staleRun = parent.currentRunId!;
      const takeover = await save([
        "session",
        "takeover",
        parent.key,
        "--if-revision",
        parent.revision,
        "--reason",
        markdown,
        "--actor",
        "new-agent",
      ]);
      parent = takeover.session;
      assert.notEqual(parent.currentRunId, staleRun);
      const stale = await run([
        "checkpoint",
        "save",
        intent.key,
        "--if-revision",
        parent.revision,
        "--run",
        staleRun,
        "--title",
        "Устаревший писатель",
        "--body",
        "Не должно сохраниться",
      ]);
      assert.notEqual(stale.code, 0, stale.stdout);
      assert.equal(stale.body.ok, false);
      assert.deepEqual((await read(parent)).session, parent);
      failed(
        await run(["session", "tree", parent.key, "--cursor", firstTree.meta!.page!.nextCursor!]),
        "VERSION_CONFLICT",
        4,
      );
      const progress = await save([
        "checkpoint",
        "save",
        intent.key,
        ...owner(parent),
        "--title",
        "Промежуточная запись",
        "--body-file",
        file,
      ]);
      parent = progress.session;
      assert.equal(progress.checkpoint?.kind, "progress");
      assert.equal(progress.checkpoint?.intentId, intent.id);

      grandchild = (
        await save([
          "session",
          "complete",
          grandchild.key,
          ...owner(grandchild),
          "--result-file",
          file,
          "--actor",
          "grandchild-agent",
        ])
      ).session;
      const unaccepted = await run([
        "checkpoint",
        "complete",
        childIntent.key,
        ...owner(child),
        "--title",
        "Без принятия",
        "--body",
        markdown,
      ]);
      assert.notEqual(unaccepted.code, 0, unaccepted.stdout);
      assert.deepEqual((await read(child)).session, child);
      const acceptedGrandchild = await save([
        "checkpoint",
        "complete",
        childIntent.key,
        ...owner(child),
        "--title",
        "Принят внук",
        "--body",
        markdown,
        "--accept",
        grandchild.id,
        "--actor",
        "child-agent",
      ]);
      child = acceptedGrandchild.session;
      assert.deepEqual(acceptedGrandchild.checkpoint?.acceptedSessionIds, [grandchild.id]);
      child = (
        await save([
          "session",
          "complete",
          child.key,
          ...owner(child),
          "--result",
          markdown,
          "--actor",
          "child-agent",
        ])
      ).session;
      assert.equal((await read(child)).acceptance, null);
      assert.equal((await read(child)).latestRun?.actor, "child-agent");
      human(await text(["session", "get", child.key]), [
        "Ожидает принятия родителем",
        "child-agent",
      ]);
      const parentResult = await save([
        "checkpoint",
        "complete",
        intent.key,
        ...owner(parent),
        "--title",
        "Принят ребёнок",
        "--body",
        markdown,
        "--accept",
        child.id,
        "--actor",
        "new-agent",
      ]);
      parent = parentResult.session;
      assert.equal((await read(child)).acceptance?.checkpointId, parentResult.checkpoint?.id);
      human(await text(["session", "get", child.key]), [parentResult.checkpoint!.key, "Принят в"]);
      const closedIntents = successful(
        await run<WorkOpenIntentsPage>(["session", "intents", parent.key, "--include-children"]),
      );
      assert.equal(closedIntents.data.total, 0);
      parent = (
        await save(
          [
            "session",
            "complete",
            parent.key,
            ...owner(parent),
            "--result-file",
            "-",
            "--actor",
            "new-agent",
          ],
          { input: markdown },
        )
      ).session;
      const final = await read(parent);
      assert.equal(final.session.status, "completed");
      assert.equal(final.session.result, markdown);
      assert.equal(final.currentRun, null);
      assert.deepEqual(final.counts, {
        runs: 3,
        checkpoints: 3,
        openIntents: 0,
        children: 1,
        unfinishedChildren: 0,
      });
      assert.equal((await read(child)).session.result, markdown);

      const historyFirst = successful(
        await run<WorkHistoryPage>([
          "session",
          "history",
          parent.key,
          "--include-children",
          "--order",
          "asc",
          "--limit",
          2,
        ]),
      );
      const all = [...historyFirst.data.items];
      let cursor = historyFirst.meta!.page!.nextCursor;
      while (cursor) {
        const page = successful(
          await run<WorkHistoryPage>(["session", "history", parent.key, "--cursor", cursor]),
        );
        all.push(...page.data.items);
        cursor = page.meta!.page!.nextCursor;
      }
      assert.equal(all.length, historyFirst.data.total);
      assert.equal(new Set(all.map((item) => item.id)).size, all.length);
      assert.deepEqual(
        new Set(all.map((item) => item.sessionId)),
        new Set([parent.id, child.id, grandchild.id]),
      );
      const desc = successful(
        await run<WorkHistoryPage>([
          "session",
          "history",
          parent.key,
          "--include-children",
          "--order",
          "desc",
          "--limit",
          100,
        ]),
      ).data;
      assert.deepEqual(
        desc.items.map((item) => item.id),
        all.map((item) => item.id).reverse(),
      );
      human(
        await text([
          "session",
          "history",
          parent.key,
          "--include-children",
          "--order",
          "asc",
          "--limit",
          100,
        ]),
        [
          "run-started",
          "run-ended",
          "session-forked",
          "checkpoint",
          "child-agent",
          "new-agent",
          "Z",
        ],
      );
      const context = successful(
        await run<WorkContext>(["session", "context", parent.key, "--limit", 2]),
      );
      assert.equal(context.data.session.description, markdown);
      assert.equal(context.data.session.result, markdown);
      assert.equal(context.meta!.page!.total, context.data.history.total);
      assert.ok(context.meta!.page!.nextCursor);
      human(await text(["session", "context", parent.key, "--limit", 100]), [
        markdown,
        "Полные материалы выбранной",
      ]);
      const projectHistory = successful(
        await run<WorkHistoryPage>(["session", "history", "--limit", 100]),
      ).data;
      assert.equal(projectHistory.total, all.length);
      const endTree = successful(
        await run<WorkTreePage>(["session", "tree", parent.key, "--limit", 1]),
      ).data;
      assert.deepEqual(endTree.totals, {
        sessions: 3,
        unfinished: 0,
        runs: 5,
        checkpoints: 5,
        openIntents: 0,
      });
      let cancelledBranch = (await save(["session", "start", "--title", "Отмена после проверки"]))
        .session;
      const cancellationIntent = await save([
        "checkpoint",
        "open",
        cancelledBranch.key,
        ...owner(cancelledBranch),
        "--title",
        "Проверить возможность",
        "--body",
        markdown,
      ]);
      cancelledBranch = cancellationIntent.session;
      const cancellationPoint = await save([
        "checkpoint",
        "cancel",
        cancellationIntent.checkpoint!.key,
        ...owner(cancelledBranch),
        "--title",
        "Отказ от намерения",
        "--body",
        markdown,
      ]);
      cancelledBranch = cancellationPoint.session;
      assert.equal(cancellationPoint.checkpoint?.kind, "cancel");
      cancelledBranch = (
        await save([
          "session",
          "cancel",
          cancelledBranch.key,
          ...owner(cancelledBranch),
          "--result",
          markdown,
        ])
      ).session;
      const cancellationRead = await read(cancelledBranch);
      assert.equal(cancellationRead.session.status, "cancelled");
      assert.equal(cancellationRead.session.result, markdown);
      assert.equal(cancellationRead.counts.openIntents, 0);
    },
  );
}

test(
  "work history: отмены, ошибки ввода без записи, точные exit/stdio и сохранённые подсказки",
  { timeout: 120_000 },
  async (t) => {
    const { root, run } = await fixture(t);
    const save = async (args: Array<string | number>, options?: RunOptions) =>
      successful(await invoke<WorkHistoryMutation>(root, args, options)).data;
    let parent = (await save(["session", "start", "--title", "Отменяемая работа"])).session;
    const owner = () => ["--if-revision", parent.revision, "--run", parent.currentRunId!];
    for (const fields of [
      [],
      ["--body", " \n\t"],
      ["--body", "A", "--body-file", "-"],
      ["--body-file", "-", "--checks-file", "-"],
    ]) {
      const response = await run([
        "checkpoint",
        "open",
        parent.key,
        ...owner(),
        "--title",
        "Недопустимый ввод",
        ...fields,
      ]);
      assert.equal(response.code, 2, response.stdout);
      assert.equal(response.body.ok, false);
      assert.equal(
        successful(await run<WorkSessionDetail>(["session", "get", parent.key])).data.session
          .revision,
        parent.revision,
      );
    }
    const opened = await save([
      "checkpoint",
      "open",
      parent.key,
      ...owner(),
      "--title",
      "Отмена",
      "--body",
      markdown,
    ]);
    parent = opened.session;
    const intent = opened.checkpoint!;
    const fork = await save(["session", "fork", intent.key, ...owner(), "--title", "Не запускать"]);
    parent = fork.session;
    const child = fork.childSession!;
    const cancelled = await save([
      "session",
      "cancel",
      child.key,
      "--if-revision",
      child.revision,
      "--result",
      markdown,
    ]);
    assert.equal(cancelled.session.result, markdown);
    assert.equal(cancelled.run, null);
    const closed = await save([
      "checkpoint",
      "cancel",
      intent.key,
      ...owner(),
      "--title",
      "Причина отмены",
      "--body",
      markdown,
    ]);
    parent = closed.session;
    assert.equal(closed.checkpoint?.kind, "cancel");
    assert.deepEqual(closed.checkpoint?.acceptedSessionIds, []);
    parent = (await save(["session", "pause", parent.key, ...owner(), "--reason", markdown]))
      .session;
    parent = (
      await save([
        "session",
        "cancel",
        parent.key,
        "--if-revision",
        parent.revision,
        "--result",
        markdown,
      ])
    ).session;
    assert.equal(parent.status, "cancelled");
    human(
      await invokeRaw(root, [
        "--config",
        join(root, ".relay/config.json"),
        "--local",
        "session",
        "get",
        parent.key,
      ]),
      ["Причина отмены", markdown],
    );
    const error = await invoke(root, ["checkpoint", "get", "CP-999"], {
      subprocess: true,
      env: { FORCE_COLOR: "3" },
    });
    assert.equal(error.body.ok, false);
    assert.notEqual(error.code, 0);
    assert.equal(error.stderr, "");
    assert.doesNotMatch(error.stdout, /\x1b/);
  },
);

test(
  "work history: пользователь и Git клиента только при подключении, источники пары не смешиваются",
  { timeout: 120_000 },
  async (t) => {
    const { root } = await fixture(t);
    const home = await tempDirectory(t);
    const outside = await tempDirectory(t);
    const execute = promisify(execFile);
    const env = {
      HOME: home,
      GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      RELAY_USER_NAME: undefined,
      RELAY_USER_EMAIL: undefined,
    };
    const git = (...args: string[]) =>
      execute("git", args, { cwd: root, env: { ...process.env, ...env } });
    await writeFile(
      env.GIT_CONFIG_GLOBAL,
      "[user]\n  name = Global User\n  email = global@example.test\n",
    );
    // Вне репозитория даже доступный global Git user не приписывается человеку.
    const start = async (cwd: string, args: string[] = [], overrides: NodeJS.ProcessEnv = {}) =>
      successful(
        await invoke<WorkHistoryMutation>(
          cwd,
          [
            "--local",
            "--config",
            join(root, ".relay/config.json"),
            "session",
            "start",
            "--title",
            "Атрибуция",
            ...args,
          ],
          { env: { ...env, ...overrides }, input: markdown },
        ),
      ).data;
    const noRepo = await start(outside);
    assert.equal(noRepo.run?.operator, null);
    assert.equal(noRepo.run?.git, null);
    await git("init", "-b", "client-branch");
    await git("config", "user.name", "Local User");
    await git("config", "user.email", "local@example.test");
    const unborn = await start(root);
    assert.deepEqual(unborn.run?.operator, {
      name: "Local User",
      email: "local@example.test",
      source: "git",
    });
    assert.deepEqual(unborn.run?.git, { branch: "client-branch", commit: null });
    await git(
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "Тестовый Git-контекст изолированной базы",
    );
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    const explicit = await start(
      root,
      ["--user-email", "explicit@example.test", "--description-file", "-"],
      { RELAY_USER_NAME: "Environment User", RELAY_USER_EMAIL: "env@example.test" },
    );
    assert.deepEqual(explicit.run?.operator, {
      name: null,
      email: "explicit@example.test",
      source: "explicit",
    });
    assert.deepEqual(explicit.run?.git, { branch: "client-branch", commit: head });
    const fromEnvironment = await start(root, [], { RELAY_USER_NAME: "Environment User" });
    assert.deepEqual(fromEnvironment.run?.operator, {
      name: "Environment User",
      email: null,
      source: "environment",
    });
    const changed = successful(
      await invoke<WorkHistoryMutation>(
        root,
        [
          "session",
          "takeover",
          explicit.session.key,
          "--if-revision",
          explicit.session.revision,
          "--reason-file",
          "-",
          "--user-name",
          "Другой человек",
          "--actor",
          "другой агент",
        ],
        { input: markdown, env },
      ),
    ).data;
    assert.deepEqual(changed.run?.operator, {
      name: "Другой человек",
      email: null,
      source: "explicit",
    });
    assert.equal(changed.run?.reason, markdown);
    const history = successful(
      await invoke<WorkHistoryPage>(
        root,
        ["session", "history", explicit.session.key, "--limit", 100],
        { env },
      ),
    ).data;
    const prior = history.items.find(
      (item) => item.kind === "run-ended" && item.run.id === explicit.run!.id,
    );
    assert.ok(prior?.kind === "run-ended");
    assert.deepEqual(prior.run.operator, explicit.run?.operator);
    assert.equal(prior.run.endReason, "transferred");
    const intent = successful(
      await invoke<WorkHistoryMutation>(
        root,
        [
          "checkpoint",
          "open",
          changed.session.key,
          "--if-revision",
          changed.session.revision,
          "--run",
          changed.run!.id,
          "--title",
          "Делегировать",
          "--body",
          markdown,
        ],
        { env },
      ),
    ).data;
    const fork = successful(
      await invoke<WorkHistoryMutation>(
        root,
        [
          "session",
          "fork",
          intent.checkpoint!.key,
          "--if-revision",
          intent.session.revision,
          "--run",
          changed.run!.id,
          "--title",
          "Дочернее поручение",
        ],
        { env },
      ),
    ).data;
    const server = await httpServer(t, root);
    const attached = successful(
      await invoke<WorkHistoryMutation>(
        root,
        [
          "--server-url",
          server.url,
          "session",
          "attach",
          fork.childSession!.key,
          "--if-revision",
          fork.childSession!.revision,
        ],
        { env },
      ),
    ).data;
    assert.deepEqual(attached.run?.operator, {
      name: "Другой человек",
      email: null,
      source: "inherited",
    });
    assert.deepEqual(attached.run?.git, { branch: "client-branch", commit: head });
    // HTTP использует cwd клиента, а не репозиторий Server.
    const remote = successful(
      await invoke<WorkHistoryMutation>(
        outside,
        ["--server-url", server.url, "session", "start", "--title", "Внешний клиент"],
        { env },
      ),
    ).data;
    assert.equal(remote.run?.operator, null);
    assert.equal(remote.run?.git, null);
    await git("checkout", "--detach", head);
    const detached = await start(root);
    assert.deepEqual(detached.run?.git, { branch: null, commit: head });
    human(await invokeRaw(root, ["session", "get", changed.session.key], { env }), [
      "Другой человек",
      "другой агент",
      "client-branch",
      head,
    ]);

    // Все чтения/help должны обходиться без обнаружения Git вообще.
    const bin = join(home, "bin");
    const marker = join(home, "git-calls");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      '#!/bin/sh\nprintf "call\\n" >> "$GIT_CALL_MARKER"\nexit 1\n',
    );
    await chmod(join(bin, "git"), 0o755);
    const unavailable = { ...env, PATH: `${bin}:${process.env.PATH}`, GIT_CALL_MARKER: marker };
    for (const args of [
      ["session", "start", "--help"],
      ["session", "get", changed.session.key],
      ["session", "history", changed.session.key],
      ["checkpoint", "get", intent.checkpoint!.key],
    ]) {
      assert.equal((await invokeRaw(root, args, { env: unavailable })).code, 0);
    }
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    const noGit = await start(root, [], unavailable);
    assert.equal(noGit.run?.git, null);
    assert.equal(noGit.run?.operator, null);
    assert.equal(await readFile(marker, "utf8"), "call\n");
  },
);
