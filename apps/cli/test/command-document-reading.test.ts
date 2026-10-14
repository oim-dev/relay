import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { EntityDetail, EntitySaved, EntitiesPage } from "@relay/contracts/entities";
import { shellCommand } from "../src/command-kit.js";
import {
  binary,
  cliEnv,
  cliNodeArgs,
  failed,
  fixture,
  invoke,
  invokeRaw,
  successful,
  tempDirectory,
} from "./helpers/cli.js";
import type { RunOptions } from "./helpers/cli.js";
import { httpProxy, httpServer } from "./helpers/http.js";

const body =
  "\n\n# Правило 雪 👩‍💻\n\n\n```ts\n\tconst literal = 'длинная строка, не получающая жёстких переносов даже на узкой ширине';\n```\n\nКонтекст:\n  npx @oim-dev/relay-cli document get DOC-999\n\nТОЛЬКОТЕЛО\n\n";

// Запускаем буквально напечатанные аргументы в Bash; заменён только launcher npx на checkout.
async function follow(cwd: string, command: string) {
  assert.ok(command.startsWith("npx @oim-dev/relay-cli "), command);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      "bash",
      [
        "-c",
        `npx() { shift; ${shellCommand([process.execPath, ...cliNodeArgs, binary])} "$@"; }\n${command}`,
      ],
      { cwd, env: cliEnv() },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        assert.equal(code, 0, stdout + stderr);
        assert.equal(stderr, "");
        resolve(stdout);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end();
  });
}

function commands(stdout: string): string[] {
  // Не рассматриваем похожую команду внутри пользовательского Markdown как служебную.
  const boundary = stdout.lastIndexOf("───\n");
  assert.ok(boundary >= 0, stdout);
  return stdout
    .slice(boundary)
    .split("\n")
    .filter((line) => line.startsWith("npx @oim-dev/relay-cli "));
}

for (const transport of ["local", "HTTP"] as const) {
  test(`document ${transport}: необязательное пояснение relations через inline/file/stdin`, async (t) => {
    const app = await fixture(t);
    const globals =
      transport === "HTTP" ? ["--server-url", (await httpServer(t, app.root)).url] : ["--local"];
    const run = <T = unknown>(args: Array<string | number>, options?: RunOptions) =>
      invoke<T>(app.root, [...globals, ...args], options);
    const feature = successful(
      await run<EntitySaved>([
        "feature",
        "create",
        "--name",
        "Цель без пояснения",
        "--description",
        "Общее требование",
      ]),
    ).data;
    const relations = [
      { target: feature.ref, type: "documents" },
      { target: feature.ref, type: "references", description: "" },
    ];
    const expected = relations.map((relation) => ({ ...relation, description: "" }));
    const path = join(app.root, "необязательные пояснения.json");
    const json = JSON.stringify(relations);
    await writeFile(path, json);
    for (const [source, args, options] of [
      ["inline", ["--relations", json], undefined],
      ["file", ["--relations-file", path], undefined],
      ["stdin", ["--relations-file", "-"], { input: json }],
    ] as const) {
      const saved = successful(
        await run<EntitySaved>(
          ["document", "create", "--name", source, "--body", "Исходное содержание", ...args],
          options,
        ),
      ).data;
      const read = async () =>
        successful(await run<EntityDetail>(["document", "get", saved.key])).data;
      const created = await read();
      assert.equal(created.revision, 1);
      assert.equal(created.data.kind, "document");
      if (created.data.kind !== "document") return;
      assert.deepEqual(created.data.relations, expected);
      successful(
        await run(
          [
            "document",
            "update",
            saved.key,
            "--if-revision",
            1,
            "--body",
            "Обновлённое содержание",
            ...args,
          ],
          options,
        ),
      );
      const updated = await read();
      assert.equal(updated.revision, 2);
      assert.equal(updated.data.kind, "document");
      if (updated.data.kind !== "document") return;
      assert.equal(updated.data.body, "Обновлённое содержание");
      assert.deepEqual(updated.data.relations, expected);
      assert.deepEqual(
        successful(await app.run<EntityDetail>(["--local", "document", "get", saved.key])).data,
        updated,
      );
      for (const description of [null, 17]) {
        failed(
          await run([
            "document",
            "update",
            saved.key,
            "--if-revision",
            2,
            "--body",
            "Не сохранять",
            "--relations",
            JSON.stringify([{ ...relations[0], description }]),
          ]),
          "VALIDATION_ERROR",
        );
        assert.deepEqual(await read(), updated);
      }
    }
  });

  test(`document ${transport}: атомарный JSON-набор, общий preflight, ошибки без частичной записи`, async (t) => {
    const app = await fixture(t);
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    let globals: string[] = ["--local"];
    if (transport === "HTTP") {
      const server = await httpServer(t, app.root);
      const proxy = await httpProxy(t, async (request, response, signal) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        if (request.method === "POST")
          posts.push({ path: request.url!, body: JSON.parse(bytes.toString()) });
        const upstream = await fetch(`${server.url}${request.url}`, {
          signal,
          method: request.method!,
          headers: { "content-type": "application/json" },
          ...(bytes.length ? { body: bytes } : {}),
        });
        response.writeHead(upstream.status, { "content-type": "application/json" });
        response.end(await upstream.text());
      });
      globals = ["--server-url", proxy.url];
    }
    const run = <T = unknown>(args: Array<string | number>, options?: RunOptions) =>
      invoke<T>(app.root, [...globals, ...args], options);
    const feature = successful(
      await run<EntitySaved>([
        "feature",
        "create",
        "--name",
        "Цель",
        "--description",
        "Требование",
      ]),
    ).data;
    const legacy = successful(
      await run<EntitySaved>([
        "feature",
        "create",
        "--name",
        "Прежняя область",
        "--description",
        "Не терять",
      ]),
    ).data;
    const relations = [
      { target: feature.ref, type: "documents", description: "\n## Пояснение\n\nПолностью.\n" },
      { target: feature.ref, type: "references", description: "Другое направление" },
      {
        target: successful(await run<EntityDetail>(["project", "get"])).data.ref,
        type: "references",
        description: "Материал проекта",
      },
    ];
    const relationFile = join(app.root, "отношения ' команды.json");
    await writeFile(relationFile, JSON.stringify(relations));
    await writeFile(join(app.root, "body.md"), body);
    posts.length = 0;
    const saved = successful(
      await run<EntitySaved>([
        "document",
        "create",
        "--name",
        "Материал",
        "--body-file",
        "body.md",
        "--relations-file",
        relationFile,
        "--targets",
        legacy.key,
      ]),
    ).data;
    assert.equal(saved.revision, 1);
    if (transport === "HTTP") {
      assert.equal(posts.length, 1);
      assert.match(posts[0]!.path, /\/entities$/);
      assert.deepEqual((posts[0]!.body.data as { relations: unknown }).relations, relations);
    }
    const read = async () =>
      successful(await run<EntityDetail>(["document", "get", saved.key])).data;
    const initial = await read();
    assert.equal(initial.data.kind, "document");
    if (initial.data.kind !== "document") return;
    assert.equal(initial.data.body, body);
    assert.deepEqual(initial.data.relations, relations);
    assert.equal(initial.data.links.length, 1);
    const initialHuman = await invokeRaw(app.root, [...globals, "document", "get", saved.key]);
    assert.match(initialHuman.stdout.replace(/\s+/g, " "), /Прикрепления: 4 · уникальных целей: 3/);
    assert.doesNotMatch(initialHuman.stdout, /Другое направление|## Пояснение/);
    const initialLinks = await invokeRaw(app.root, [...globals, "document", "links", saved.key]);
    assert.match(initialLinks.stdout, /Прочитать PROJECT\nnpx/);
    const projectHint = commands(initialLinks.stdout).find((command) =>
      command.endsWith("project get"),
    );
    assert.ok(projectHint, initialLinks.stdout);
    assert.match(await follow(app.root, projectHint), /PROJECT/);
    const changed = [relations[1]!];
    posts.length = 0;
    successful(
      await run([
        "document",
        "update",
        saved.key,
        "--if-revision",
        1,
        "--body",
        "Новый полный текст",
        "--relations",
        JSON.stringify(changed),
      ]),
    );
    if (transport === "HTTP") {
      assert.equal(posts.length, 1);
      assert.match(posts[0]!.path, /\/entities\/update$/);
      assert.deepEqual((posts[0]!.body.changes as { relations: unknown }).relations, changed);
    }
    let current = await read();
    assert.equal(current.revision, 2);
    assert.equal(current.data.kind, "document");
    if (current.data.kind !== "document") return;
    assert.equal(current.data.body, "Новый полный текст");
    assert.deepEqual(current.data.relations, changed);
    assert.deepEqual(current.data.links, initial.data.links);
    const graph = successful(
      await run<{ edges: { from: { id: string }; to: { id: string }; type: string }[] }>([
        "inspect",
        "graph",
        "list",
        "--root",
        saved.key,
      ]),
    ).data;
    assert.ok(
      graph.edges.some(
        (edge) =>
          edge.from.id === feature.ref.id &&
          edge.to.id === saved.ref.id &&
          edge.type === "references",
      ),
    );
    assert.ok(
      !graph.edges.some(
        (edge) =>
          edge.from.id === saved.ref.id &&
          edge.to.id === feature.ref.id &&
          edge.type === "documents",
      ),
    );

    for (const fields of [
      ["--relations", "[]", "--relations-file", "missing.json"],
      ["--relations-file", "missing.json", "--clear-relations"],
      ["--relations", "[]", "--clear-relations"],
      ["--body-file", "-", "--relations-file", "-"],
      ["--summary-file", "-", "--relations-file", "-"],
      ["--body", "inline", "--body-file", "missing.md"],
    ]) {
      posts.length = 0;
      const args = ["document", "update", saved.key, "--if-revision", 2, ...fields];
      failed(await run(args), "CONFLICTING_OPTIONS");
      assert.equal(posts.length, 0);
      const human = await invokeRaw(app.root, [...globals, ...args]);
      assert.equal(human.code, 2, human.stdout);
      assert.equal(human.stderr, "");
      assert.match(human.stdout, /Выберите один источник/);
      assert.doesNotMatch(human.stdout, /Перечитайте запись|свежую ревизию/);
      assert.deepEqual(await read(), current);
    }
    for (const value of [
      "{",
      "{}",
      JSON.stringify([relations[0], relations[0]]),
      JSON.stringify([{ target: { kind: "feature", id: "missing" }, type: "documents" }]),
    ]) {
      const result = await run([
        "document",
        "update",
        saved.key,
        "--if-revision",
        2,
        "--body",
        "НЕ СОХРАНЯТЬ",
        "--relations",
        value,
      ]);
      assert.equal(result.body.ok, false, result.stdout);
      assert.equal(result.stderr, "");
      assert.deepEqual(await read(), current);
      const before = successful(await run<EntitiesPage>(["document", "list"])).data;
      const rejectedCreate = await run([
        "document",
        "create",
        "--name",
        "Не создавать частично",
        "--body",
        "НЕ СОХРАНЯТЬ",
        "--relations",
        value,
      ]);
      assert.equal(rejectedCreate.body.ok, false, rejectedCreate.stdout);
      assert.deepEqual(successful(await run<EntitiesPage>(["document", "list"])).data, before);
    }
    const stale = await invokeRaw(app.root, [
      ...globals,
      "document",
      "update",
      saved.key,
      "--if-revision",
      1,
      "--body",
      "НЕ СОХРАНЯТЬ",
      "--relations",
      "[]",
    ]);
    assert.equal(stale.code, 4, stale.stdout);
    assert.match(stale.stdout, /REVISION_CONFLICT/);
    assert.match(stale.stdout, /не подставляйте свежую ревизию/);
    assert.deepEqual(await read(), current);
    successful(
      await run([
        "document",
        "update",
        saved.key,
        "--if-revision",
        2,
        "--summary",
        "Только аннотация",
      ]),
    );
    current = await read();
    assert.equal(current.data.kind, "document");
    if (current.data.kind !== "document") return;
    assert.deepEqual(current.data.relations, changed);
    successful(
      await run(
        [
          "document",
          "update",
          saved.key,
          "--if-revision",
          3,
          "--body-file",
          "body.md",
          "--relations-file",
          "-",
        ],
        { input: "[]" },
      ),
    );
    current = await read();
    assert.equal(current.revision, 4);
    assert.equal(current.data.kind, "document");
    if (current.data.kind !== "document") return;
    assert.deepEqual(current.data.relations, []);
    assert.deepEqual(current.data.links, initial.data.links);
    assert.equal(current.data.body, body);
    assert.deepEqual(
      successful(await app.run<EntityDetail>(["--local", "document", "get", saved.key])).data,
      current,
    );
  });
}

test("document reading: 20 аннотаций, 40 отношений, literal Markdown и копируемый путь local/HTTP/workspace", async (t) => {
  const app = await fixture(t);
  const docs: EntitySaved[] = [];
  const longSummary = "Когда выбирать A.\n\n" + "雪 👩‍💻 ".repeat(100) + "КОНЕЦ АННОТАЦИИ";
  for (let index = 0; index < 20; index++) {
    docs.push(
      successful(
        await app.run<EntitySaved>([
          "document",
          "create",
          "--name",
          `Регламент ${index + 1}`,
          "--body",
          index === 0 ? body : "Другой полный текст",
          "--summary",
          index === 0 ? longSummary : index === 1 ? "" : `Когда выбирать материал ${index + 1}.`,
          "--section-id",
          "product",
        ]),
      ).data,
    );
  }
  const feature = successful(
    await app.run<EntitySaved>([
      "feature",
      "create",
      "--name",
      "Цель",
      "--description",
      "Требование",
    ]),
  ).data;
  const targets = [feature, ...docs.slice(1)];
  const relations = targets.flatMap((target, index) =>
    ["documents", "references"].map((type) => ({
      target: target.ref,
      type,
      description: `\n## Пояснение ${index} ${type}\n\n${"Полное соседнее пояснение. ".repeat(40)}\nКОНЕЦ ПОЯСНЕНИЯ ${index} ${type}\n`,
    })),
  );
  const relationsFile = join(app.root, "relations.json");
  await writeFile(relationsFile, JSON.stringify(relations));
  const key = docs[0]!.key;
  successful(
    await app.run([
      "document",
      "update",
      key,
      "--if-revision",
      1,
      "--relations-file",
      relationsFile,
    ]),
  );
  const expected = successful(await app.run<EntityDetail>(["document", "get", key])).data;
  const server = await httpServer(t, app.root);
  const empty = await tempDirectory(t);
  const alias = join(empty, "проект с ' кавычкой");
  await symlink(app.root, alias);
  const workspace = await tempDirectory(t);
  successful(await invoke(workspace, ["workspace", "project", "init"]));
  const workspaceServer = await httpServer(t, workspace);
  const configPath = join(workspace, "relay.workspace.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(
    configPath,
    JSON.stringify({ ...config, server: { port: 0, url: workspaceServer.url } }),
  );
  successful(
    await invoke(workspace, [
      "workspace",
      "project",
      "add",
      "docs",
      app.root,
      "--project-config",
      ".relay/config.json",
    ]),
  );

  for (const [name, cwd, globals, env] of [
    ["local", app.root, [], {}],
    ["explicit local", empty, ["--local", "--config", join(alias, ".relay/config.json")], {}],
    ["env config", empty, [], { RELAY_CONFIG: join(alias, ".relay/config.json") }],
    ["HTTP env", empty, [], { RELAY_SERVER_URL: server.url }],
    ["workspace", workspace, ["--project", "docs"], {}],
  ] as const) {
    await t.test(name, async () => {
      const raw = (args: Array<string | number>, width = 100) =>
        invokeRaw(cwd, [...globals, ...args], {
          env: { ...env, COLUMNS: String(width), FORCE_COLOR: "3" },
        });
      const json = successful(
        await invoke<EntityDetail>(cwd, [...globals, "document", "get", key], { env }),
      ).data;
      assert.deepEqual(json, expected);
      for (const width of [24, 40, 100, 160]) {
        const out = await raw(["document", "get", key], width);
        assert.equal(out.code, 0, out.stdout);
        assert.equal(out.stderr, "");
        assert.ok(out.stdout.includes(body));
        assert.ok(out.stdout.includes(longSummary));
        assert.doesNotMatch(out.stdout, /Пояснение 0|КОНЕЦ ПОЯСНЕНИЯ|\u001b/);
        assert.match(out.stdout.replace(/\s+/g, " "), /Прикрепления: 40 · уникальных целей: 20/);
        assert.ok(out.stdout.indexOf("───\n") > out.stdout.indexOf(body));
        const hints = commands(out.stdout);
        assert.equal(hints.length, 3);
        assert.match(hints[0]!, /document links/);
        assert.match(hints[2]!, /document delete-preview/);
        assert.ok(
          Buffer.byteLength(out.stdout) < 8000,
          `Карточка раскрыла соседние пояснения: ${Buffer.byteLength(out.stdout)}`,
        );
      }
      const list = await raw(["document", "list", "--sort", "key", "--limit", 20], 40);
      assert.equal(list.code, 0, list.stdout);
      assert.match(list.stdout, /Аннотация \(фрагмент\)/);
      assert.doesNotMatch(list.stdout, /КОНЕЦ АННОТАЦИИ|ТОЛЬКОТЕЛО|Изменён:/);
      assert.equal((list.stdout.match(/Аннотация/g) ?? []).length, 19);
      assert.equal(commands(list.stdout).length, 1);
      const get = await follow(cwd, commands(list.stdout)[0]!);
      assert.ok(get.includes(body));
      const preview = await follow(cwd, commands(get)[2]!);
      assert.match(preview, /Полный каскад удаления/);
      const links = await follow(cwd, commands(get)[0]!);
      assert.match(links, /КОНЕЦ ПОЯСНЕНИЯ 0 documents/);
      const targetHints = commands(links).filter((line) => / (feature|document) get /.test(line));
      assert.equal(targetHints.length, 2, links);
      const target = await follow(
        cwd,
        targetHints.find((line) => line.includes("feature get"))!,
      );
      assert.match(target, /Требование/);
      const nextHint = commands(links).find((line) => line.includes("--cursor"));
      assert.ok(nextHint, links);
      const last = await follow(cwd, nextHint);
      assert.match(last, /КОНЕЦ ПОЯСНЕНИЯ 19 references/);
      assert.match(last, /Конец списка/);
      const sections = await raw(["document", "section", "list"]);
      const inSection = await follow(cwd, commands(sections.stdout)[0]!);
      assert.match(inSection, /Раздел:\s*product/);
      assert.match(inSection, /Регламент 1/);
      const search = await raw(["search", "ТОЛЬКОТЕЛО", "--kind", "document"]);
      assert.match(search.stdout, /Совпадение в содержании \(фрагмент\)/);
      assert.match(search.stdout, /ТОЛЬКОТЕЛО/);
      assert.equal(commands(search.stdout).length, 1);
      const summaryMatch = await raw(["document", "list", "--q", "Когда выбирать", "--limit", 20]);
      assert.doesNotMatch(summaryMatch.stdout, /Совпадение в содержании/);
      const searchPage = await raw(["search", "--kind", "document", "--limit", 20]);
      assert.equal(commands(searchPage.stdout).length, 1);
      const sorted = await raw(["document", "list", "--sort", "updated", "--limit", 1]);
      assert.match(sorted.stdout, /Изменён:/);
      assert.ok(sorted.stdout.includes(expected.document!.updatedAt));
      const noMatches = await raw(["document", "list", "--q", "НЕТТАКОГО"]);
      assert.match(noMatches.stdout, /Сущностей по этим условиям нет/);
      assert.doesNotMatch(noMatches.stdout, /npx @oim-dev\/relay-cli/);
      const unattached = await raw(["document", "get", docs[1]!.key]);
      assert.match(unattached.stdout, /Прикреплений нет/);
      assert.doesNotMatch(unattached.stdout, /Аннотация/);
    });
  }
});
