import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openWorkspace } from "@relay/core/storage/workspace";
import { EntityEngine } from "@relay/core/application/entities/service";
import { GraphService } from "@relay/core/application/graph/service";
import {
  entityAddress,
  type GraphPage,
  type FullContext,
  type GraphMutation,
} from "@relay/core/domain/entity-graph";
import type { EntityDetail, EntitySaved } from "@relay/contracts/entities";
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
import { httpServer, httpProxy } from "./helpers/http.js";

const markdown =
  "\n\n## Unicode 🧪 е́ 中文\n\n  отступ  \n\tтабуляция\n```sh\necho 'не команда CLI'\n```\n\nПоказано: 0\nЕсть продолжение\nnpx @oim-dev/relay-cli НЕ_КОМАНДА\n\u001b[31mХВОСТ\n\n";
const human = (result: Awaited<ReturnType<typeof invokeRaw>>) => {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /\u001b|\[object Object\]/);
  return result.stdout;
};
// Это только выбор служебных подсказок из известной фикстуры, не парсер произвольного Markdown.
const hints = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("npx @oim-dev/relay-cli ") && !line.includes("НЕ_КОМАНДА"));
const token = (text: string, label: string) => {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${label}:`));
  assert.ok(index >= 0, text);
  return lines[index]!.slice(label.length + 1).trim() || lines[index + 1]!.trim();
};
async function follow(cwd: string, command: string): Promise<string> {
  assert.ok(command.startsWith("npx @oim-dev/relay-cli "), command);
  const result = await promisify(execFile)(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `npx() { shift; ${shellCommand([process.execPath, ...cliNodeArgs, binary])} "$@"; }\n${command}`,
    ],
    { cwd, env: cliEnv(), timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
  );
  assert.equal(result.stderr, "");
  return result.stdout;
}
async function evidence(t: TestContext, name: string, text: string) {
  const metrics = {
    name,
    stdoutBytes: Buffer.byteLength(text),
    physicalLines: text.split("\n").length - 1,
  };
  t.diagnostic(JSON.stringify(metrics));
  if (process.env.INSPECT_EVIDENCE_DIR) {
    await mkdir(process.env.INSPECT_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.INSPECT_EVIDENCE_DIR, `${name}.stdout`), text);
  }
}

test("inspect: семь leaves и группы дают help без базы", async (t) => {
  const cwd = await tempDirectory(t);
  for (const args of [
    [],
    ["graph"],
    ["types"],
    ["type"],
    ["resolve"],
    ["keys"],
    ["key-spaces"],
    ["graph", "list"],
    ["graph", "context"],
  ]) {
    const text = human(await invokeRaw(cwd, ["inspect", ...args, "--help"]));
    assert.match(text, /Примеры:/);
  }
  human(await invokeRaw(cwd, ["board", "rename", "--help"]));
  assert.deepEqual(await readdir(cwd), []);
});

for (const transport of ["local", "HTTP", "workspace"] as const) {
  test(
    `inspect ${transport}: scope, соседи, дальние пояснения, JSON/Core, страницы и rename`,
    { timeout: 300_000 },
    async (t) => {
      const app = await fixture(t);
      const workspace = await openWorkspace(app.root);
      const entities = new EntityEngine(workspace);
      const graph = new GraphService(workspace);
      await entities.create(
        {
          data: {
            kind: "application",
            name: "Приложение владельца",
            summary: "",
            description: "Область ключей",
            slug: "scope-owner",
            prefix: "OWNER",
            type: "internal",
          },
          requestId: "scope-owner",
        },
        "inspect-fixture",
      );
      const docs: EntitySaved[] = [];
      for (let i = 0; i < 8; i++)
        docs.push(
          await entities.create(
            {
              data: {
                kind: "document",
                summary: "",
                documentKind: "description",
                name: `Документ ${i} — похожее длинное название с Unicode 🧪 е́ 中文`,
                body: `Полное содержание ${i}\n\n${markdown}`,
              },
              requestId: `doc-${i}`,
            },
            "inspect-fixture",
          ),
        );
      const operations: GraphMutation["operations"] = [
        ...docs.slice(0, 6).map((doc, i) => ({
          action: "add" as const,
          from: doc.key,
          to: docs[i + 1]!.key,
          type: "references",
          description: `DEEP_${i}\n${markdown}`,
        })),
        {
          action: "add",
          from: docs[1]!.key,
          to: docs[0]!.key,
          type: "references",
          description: "Обратно",
        },
        {
          action: "add",
          from: docs[0]!.key,
          to: docs[1]!.key,
          type: "documents",
          description: "Параллельно",
        },
        {
          action: "add",
          from: docs[2]!.key,
          to: docs[2]!.key,
          type: "references",
          description: "Петля",
        },
      ];
      await graph.mutate(
        { operations, ifVersion: (await graph.read({})).version, requestId: "chain" },
        "inspect-fixture",
      );
      const initialGraph = await graph.read({ root: docs[0]!.key });
      const markedEdge = initialGraph.edges[0]!;
      await graph.mutate(
        {
          operations: [
            {
              action: "update",
              id: markedEdge.id,
              description: `${markedEdge.description}\nНачало пояснения ${markedEdge.id}\nКонец пояснения ${markedEdge.id}\nЭто всё ещё пользовательское содержание.\n`,
            },
          ],
          ifVersion: initialGraph.version,
          requestId: "literal-markers",
        },
        "inspect-fixture",
      );
      const config = join(app.root, ".relay", "config with 'quote.json");
      await copyFile(join(app.root, ".relay/config.json"), config);
      let cwd = app.root;
      let flags: string[] = ["--local"];
      let env: NodeJS.ProcessEnv = { RELAY_CONFIG: config };
      const requests: string[] = [];
      if (transport !== "local") {
        if (transport === "workspace") {
          cwd = await tempDirectory(t);
          await writeFile(
            join(cwd, "relay.workspace.json"),
            JSON.stringify({ version: 1, projects: { chosen: { path: app.root } } }),
          );
        }
        const server = await httpServer(t, cwd);
        const proxy = await httpProxy(t, async (request, response, signal) => {
          requests.push(`${request.method} ${request.url}`);
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const upstream = await fetch(`${server.url}${request.url}`, {
            signal,
            method: request.method ?? "GET",
            headers: { "content-type": "application/json" },
            ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
          });
          response.writeHead(upstream.status, { "content-type": "application/json" });
          response.end(await upstream.text());
        });
        flags = transport === "workspace" ? ["--project", "chosen"] : [];
        env = {
          RELAY_SERVER_URL: proxy.url,
          ...(transport === "HTTP" ? { RELAY_CONFIG: config } : {}),
        };
      }
      const run = <T = unknown>(args: Array<string | number>) =>
        invoke<T>(cwd, [...flags, ...args], { env });
      const text = async (args: Array<string | number>, width = 100) =>
        human(
          await invokeRaw(cwd, [...flags, ...args], {
            env: { ...env, COLUMNS: String(width), FORCE_COLOR: "1", NO_COLOR: undefined },
          }),
        );
      for (const args of [
        ["types"],
        ["type", "document"],
        ["resolve", docs[0]!.key],
        ["keys", docs[0]!.key],
        ["key-spaces", "task"],
        ["graph", "list"],
        ["graph", "context", docs[0]!.key],
      ]) {
        requests.length = 0;
        successful(await run(["inspect", ...args]));
        if (transport !== "local") assert.equal(requests.length, 2, JSON.stringify(requests));
      }
      for (const kind of ["task", "board", "application", "implementation", "project"] as const) {
        const page = successful(await run<any>(["inspect", "key-spaces", kind])).data;
        assert.deepEqual(page, await entities.keySpaces({ kind, limit: 20 }));
        const output = await text(["inspect", "key-spaces", kind], 40);
        for (const item of page.items) {
          if (item.scope) assert.ok(output.includes(entityAddress(item.scope)), output);
          else assert.match(output.replace(/\s+/g, " "), /Общее пространство вида/);
        }
        for (const hint of hints(output)) assert.match(await follow(cwd, hint), /Ревизия/);
      }
      const full = successful(
        await run<FullContext>(["inspect", "graph", "context", docs[0]!.key]),
      ).data;
      assert.deepEqual(full, await graph.context({ root: docs[0]!.key }));
      assert.equal(full.nodes.length, 7);
      assert.equal(full.edges.length, 9);
      const contextText = await text(["inspect", "graph", "context", docs[0]!.key]);
      for (const doc of docs.slice(0, 7)) {
        const hint = hints(contextText).find((line) => line.endsWith(`document get ${doc.key}`));
        assert.ok(hint, contextText);
        assert.ok((await follow(cwd, hint)).includes(`Полное содержание ${docs.indexOf(doc)}`));
      }
      const deepHint = hints(contextText).find((line) =>
        line.includes(`--root ${entityAddress(docs[5]!.ref)} `),
      );
      assert.ok(deepHint, contextText);
      assert.match(await follow(cwd, deepHint), /DEEP_5/);
      const selection = [
        "inspect",
        "graph",
        "list",
        "--root",
        docs[0]!.key,
        "--depth",
        3,
        "--direction",
        "outgoing",
        "--type",
        "references",
        "--profile",
        "context",
        "--limit",
        20,
      ];
      const limited = successful(await run<GraphPage>(selection)).data;
      assert.deepEqual(
        limited,
        await graph.read({
          root: docs[0]!.key,
          depth: 3,
          direction: "outgoing",
          type: "references",
          profile: "context",
          limit: 20,
        }),
      );
      assert.ok(
        limited.edges.some(
          (edge) => edge.from.id === docs[1]!.ref.id && edge.to.id === docs[0]!.ref.id,
        ),
        "обратное ребро сохраняется",
      );
      const limitedText = await text(selection, 40);
      assert.match(limitedText, /Направление обхода/);
      const boundary = hints(limitedText).find((line) =>
        line.includes(`--root ${entityAddress(docs[3]!.ref)} `),
      );
      assert.ok(boundary, limitedText);
      for (const fragment of [
        "--depth 3",
        "--direction outgoing",
        "--type references",
        "--profile context",
      ])
        assert.ok(boundary.includes(fragment), boundary);
      const deep = await follow(cwd, boundary);
      for (const marker of ["DEEP_3", "DEEP_4", "DEEP_5"]) assert.ok(deep.includes(marker), deep);
      const allPage = successful(
        await run<GraphPage>([
          "inspect",
          "graph",
          "list",
          "--root",
          docs[0]!.key,
          "--depth",
          100,
          "--limit",
          100,
        ]),
      ).data;
      assert.deepEqual(allPage, await graph.read({ root: docs[0]!.key, depth: 100, limit: 100 }));
      for (const width of [40, 100]) {
        const output = await text(
          ["inspect", "graph", "list", "--root", docs[0]!.key, "--depth", 100, "--limit", 100],
          width,
        );
        for (const edge of allPage.edges) {
          assert.ok(output.includes(edge.id));
          const from = allPage.endpoints.find(
            (node) => entityAddress(node.ref) === entityAddress(edge.from),
          )!;
          const to = allPage.endpoints.find(
            (node) => entityAddress(node.ref) === entityAddress(edge.to),
          )!;
          assert.ok(output.includes(`${from.key} ── ${edge.type} → ${to.key}`));
          const card = output.slice(output.indexOf(edge.id)).split("Пользовательский Markdown")[0]!;
          assert.match(card, new RegExp(`Ревизия:\\s+${edge.revision}(?:\\s|$)`));
          if (edge.description)
            assert.ok(
              output.includes(
                `Начало пояснения ${edge.id}\n${edge.description.replaceAll("\u001b", "\\u001b")}\nКонец пояснения ${edge.id}`,
              ),
              output,
            );
        }
        await evidence(t, `${transport}-list-7-9-${width}`, output);
        const context = await text(["inspect", "graph", "context", docs[0]!.key], width);
        for (const node of full.nodes) {
          // Заголовок может переноситься, но не повторяется у концов рёбер/в путях.
          assert.equal(context.replace(/\s+/g, " ").split(node.title).length - 1, 1);
        }
        await evidence(t, `${transport}-context-7-9-${width}`, context);
        if (transport === "local") {
          for (const mode of ["context", "list"] as const) {
            const args =
              mode === "context"
                ? ["inspect", "graph", "context", docs[0]!.key]
                : [
                    "inspect",
                    "graph",
                    "list",
                    "--root",
                    docs[0]!.key,
                    "--depth",
                    "100",
                    "--limit",
                    "100",
                  ];
            await evidence(
              t,
              `plain-${mode}-7-9-${width}`,
              human(await invokeRaw(app.root, args, { env: { COLUMNS: String(width) } })),
            );
          }
        }
      }
      let page = successful(
        await run<GraphPage>([
          "inspect",
          "graph",
          "list",
          "--root",
          docs[0]!.key,
          "--depth",
          1,
          "--limit",
          1,
        ]),
      );
      let emptyNodes = false;
      const nodes = new Set<string>();
      const edges = new Set<string>();
      for (;;) {
        for (const node of page.data.nodes) {
          assert.ok(!nodes.has(entityAddress(node.ref)));
          nodes.add(entityAddress(node.ref));
        }
        for (const edge of page.data.edges) {
          assert.ok(!edges.has(edge.id));
          edges.add(edge.id);
        }
        const next = page.meta!.page!.nextCursor;
        if (!next) break;
        const args = ["inspect", "graph", "list", "--cursor", next];
        page = successful(await run<GraphPage>(args));
        if (!page.data.nodes.length && page.data.edges.length) {
          emptyNodes = true;
          const output = await text(args, 40);
          assert.match(output.replace(/\s+/g, " "), /на этой странице граничных узлов нет/);
          for (const endpoint of page.data.endpoints)
            assert.ok(output.includes(entityAddress(endpoint.ref)));
        }
      }
      assert.ok(emptyNodes);
      assert.equal(nodes.size, page.data.totalNodes);
      assert.equal(edges.size, page.data.totalEdges);
      const isolated = successful(
        await run<FullContext>(["inspect", "graph", "context", docs[7]!.key]),
      ).data;
      assert.equal(isolated.edges.length, 0);
      assert.equal(isolated.nodes.length, 1);
      const empty = await text(["inspect", "graph", "list", "--q", "не-найдено"]);
      assert.match(empty, /0 сущностей, 0 отношений/);
      assert.match(empty, /Конец списка/);
      if (transport === "local") await evidence(t, "empty-0-0-100", empty);
      // Непрозрачные значения берём именно из text и используем в следующей реальной записи.
      for (const width of [24, 40, 100]) {
        const output = await text(["inspect", "graph", "list", "--root", docs[0]!.key], width);
        const version = token(output, "Версия");
        const id = token(output, "ID отношения");
        assert.equal(version, (await graph.read({ root: docs[0]!.key })).version);
        const saved = successful(
          await run<any>([
            "doctor",
            "graph",
            "update",
            id,
            "--if-version",
            version,
            "--description",
            `После ${width}`,
          ]),
        ).data;
        const read = successful(
          await run<GraphPage>(["inspect", "graph", "list", "--root", docs[0]!.key]),
        ).data;
        assert.equal(read.version, saved.version);
        assert.equal(read.edges.find((edge) => edge.id === id)?.description, `После ${width}`);
        assert.equal(
          token(await text(["inspect", "graph", "context", docs[0]!.key], width), "Версия"),
          saved.version,
        );
      }
      const board = successful(await run<EntityDetail>(["board", "get", "BOARD-PRODUCT"])).data;
      failed(
        await invoke(
          cwd,
          [
            ...flags,
            "board",
            "rename",
            board.key,
            "BOARD-NO-ACTOR",
            "--if-revision",
            board.revision,
          ],
          { env: { ...env, RELAY_ACTOR: undefined } },
        ),
        "ACTOR_REQUIRED",
      );
      failed(
        await run(["board", "rename", "PROJECT", "BOARD-WRONG-KIND", "--if-revision", 1]),
        "ENTITY_KIND_MISMATCH",
        4,
      );
      const rename = await text([
        "board",
        "rename",
        board.key,
        "BOARD-TEAM",
        "--if-revision",
        board.revision,
        "--actor",
        "inspect-author",
      ]);
      assert.match(rename, /Ключ изменён: BOARD-TEAM/);
      assert.match(await follow(cwd, hints(rename)[0]!), /BOARD-TEAM/);
      failed(
        await run(["board", "rename", board.key, "BOARD-STALE", "--if-revision", board.revision]),
        "REVISION_CONFLICT",
        4,
      );
      const after = successful(await run<EntityDetail>(["board", "get", board.key])).data;
      assert.deepEqual(after.ref, board.ref);
      assert.equal(after.revision, board.revision + 1);
      failed(
        await run(["board", "rename", after.key, "PROJECT", "--if-revision", after.revision]),
        "ENTITY_KEY_CONFLICT",
        4,
      );
      for (const field of ["name", "slug", "prefix", "applicationId", "scope"] as const)
        assert.equal((after.data as any)[field], (board.data as any)[field]);
      const saved = successful(
        await run<EntitySaved>([
          "board",
          "rename",
          board.key,
          "BOARD-FINAL",
          "--if-revision",
          after.revision,
          "--request-id",
          "rename-board",
        ]),
      ).data;
      assert.equal(saved.action, "rename");
      assert.equal(saved.requestId, "rename-board");
      assert.deepEqual(saved.ref, board.ref);
      for (const ref of [board.key, "BOARD-TEAM", "BOARD-FINAL", entityAddress(board.ref)])
        assert.deepEqual(
          successful(await run<any>(["inspect", "resolve", ref])).data.ref,
          board.ref,
        );
      assert.equal(successful(await run<any>(["inspect", "keys", board.key])).data.items.length, 3);
      // Общий project rename уже реализован; здесь проверяется лишь стык inspect с его алиасами.
      const project = successful(await run<EntityDetail>(["project", "get"])).data;
      const renamedProject = successful(
        await run<EntitySaved>([
          "project",
          "rename",
          "PROJECT-INSPECT",
          "--if-revision",
          project.revision,
        ]),
      ).data;
      assert.deepEqual(renamedProject.ref, project.ref);
      assert.deepEqual(
        successful(await run<any>(["inspect", "resolve", "PROJECT"])).data.ref,
        project.ref,
      );
    },
  );
}

test(
  "inspect: dense 20/40, длинные названия один раз и смешанные get",
  { timeout: 180_000 },
  async (t) => {
    const app = await fixture(t);
    const workspace = await openWorkspace(app.root);
    const entities = new EntityEngine(workspace);
    const graph = new GraphService(workspace);
    const docs: EntitySaved[] = [];
    for (let i = 0; i < 20; i++)
      docs.push(
        await entities.create(
          {
            data: {
              kind: "document",
              summary: "",
              documentKind: "description",
              name: `Номер ${i} — длинное похожее название документа для сравнения полного контекста 🧪 е́ 中文`,
              body: "Полное содержание. ".repeat(100),
            },
            requestId: `dense-${i}`,
          },
          "inspect-fixture",
        ),
      );
    const operations: GraphMutation["operations"] = docs.flatMap((doc, i) => [
      {
        action: "add",
        from: doc.key,
        to: docs[(i + 1) % 20]!.key,
        type: "references",
        description: `Пояснение ${i}\n\n  Без потерь\n`,
      },
      {
        action: "add",
        from: doc.key,
        to: docs[(i + 1) % 20]!.key,
        type: "documents",
        description: "",
      },
    ]);
    await graph.mutate(
      { operations, ifVersion: (await graph.read({})).version, requestId: "dense" },
      "inspect-fixture",
    );
    const full = successful(
      await app.run<FullContext>(["inspect", "graph", "context", docs[0]!.key]),
    ).data;
    assert.deepEqual(full, await graph.context({ root: docs[0]!.key }));
    assert.equal(full.nodes.length, 20);
    assert.equal(full.edges.length, 40);
    for (const width of [40, 100])
      for (const mode of ["context", "list"]) {
        const args =
          mode === "context"
            ? ["inspect", "graph", "context", docs[0]!.key]
            : [
                "inspect",
                "graph",
                "list",
                "--root",
                docs[0]!.key,
                "--depth",
                "100",
                "--limit",
                "20",
              ];
        const output = human(
          await invokeRaw(app.root, args, { env: { COLUMNS: String(width), FORCE_COLOR: "1" } }),
        );
        for (const node of full.nodes)
          assert.equal(output.replace(/\s+/g, " ").split(node.title).length - 1, 1);
        if (mode === "context") for (const edge of full.edges) assert.ok(output.includes(edge.id));
        await evidence(t, `dense-${mode}-${width}`, output);
      }
    successful(
      await app.run(["product", "create", "--name", "Продукт", "--description", "Паспорт"]),
    );
    const plan = successful(await app.run<any>(["plan", "create", "--title", "План"])).data;
    const feature = successful(
      await app.run<EntitySaved>([
        "feature",
        "create",
        "--name",
        "Фича",
        "--description",
        "Требования",
      ]),
    ).data;
    const product = await entities.resolve({ ref: "product:passport" });
    await graph.mutate(
      {
        operations: [
          { action: "add", from: "PROJECT", to: product.key, type: "related" },
          { action: "add", from: product.key, to: plan.key, type: "related" },
          { action: "add", from: plan.key, to: "BOARD-PRODUCT", type: "related" },
          { action: "add", from: "BOARD-PRODUCT", to: feature.key, type: "related" },
        ],
        ifVersion: (await graph.read({})).version,
        requestId: "mixed",
      },
      "inspect-fixture",
    );
    const mixed = human(await invokeRaw(app.root, ["inspect", "graph", "context", "PROJECT"]));
    for (const suffix of [
      "project get",
      "product get",
      `plan get ${plan.key}`,
      "board get BOARD-PRODUCT",
      `feature get ${feature.key}`,
    ]) {
      const hint = hints(mixed).find((line) => line.endsWith(suffix));
      assert.ok(hint, mixed);
      assert.match(await follow(app.root, hint), /Ревизия/);
    }
  },
);
