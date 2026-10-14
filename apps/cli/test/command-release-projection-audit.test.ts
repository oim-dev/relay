import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlanningSaved } from "@relay/contracts/planning";
import type { ReleaseSummary } from "@relay/contracts/releases";
import { fixture, invoke, invokeRaw, successful, failed, tempDirectory } from "./helpers/cli.js";
import { httpServer, httpProxy } from "./helpers/http.js";

type Page = {
  items: Record<string, any>[];
  total: number;
  version: string;
  readiness?: unknown;
  statusCounts?: unknown;
};

for (const mode of ["local", "http"] as const)
  test(
    `REL-02/03 ${mode}: description до страниц, compact opt-in и прежний полный JSON`,
    { timeout: 120_000 },
    async (t) => {
      const { root, run } = await fixture(t);
      const plans: PlanningSaved[] = [];
      const goal = "## Полная цель\n\n" + "Длинное обоснование 世界. ".repeat(200);
      for (let index = 0; index < 3; index++)
        plans.push(
          successful(
            await run<PlanningSaved>([
              "plan",
              "create",
              "--title",
              `План ${index}`,
              "--goal",
              goal,
            ]),
          ).data,
        );
      const description =
        "## Полное описание\n\n" +
        "Подробное содержание 世界. ".repeat(300) +
        "ОписаниеТолькоМаркер";
      const releases: PlanningSaved[] = [];
      for (let index = 0; index < 3; index++)
        releases.push(
          successful(
            await run<PlanningSaved>([
              "release",
              "create",
              "--title",
              `Выпуск ${index}`,
              "--release-version",
              "1",
              "--plans",
              ...plans.map((plan) => plan.key),
              "--description",
              description,
              ...(index === 2 ? ["--status", "cancelled"] : []),
            ]),
          ).data,
        );
      const server = mode === "http" ? await httpServer(t, root) : undefined;
      const connection = server ? ["--server-url", server.url] : ["--local"];
      const json = <T = Page>(args: Array<string | number>) =>
        invoke<T>(root, [...connection, ...args]);
      const normal = await json(["release", "list", "--limit", 3]);
      const compact = await json(["release", "list", "--projection", "compact", "--limit", 3]);
      const fullPage = successful(normal);
      const compactPage = successful(compact);
      assert.deepEqual(
        compactPage.data.items.map((item) => item.id),
        fullPage.data.items.map((item) => item.id),
      );
      assert.deepEqual(compactPage.data.statusCounts, fullPage.data.statusCounts);
      assert.equal(compactPage.meta?.page?.total, 3);
      for (const item of fullPage.data.items) assert.equal(item.description, description);
      for (const item of compactPage.data.items) {
        assert.equal(Object.hasOwn(item, "description"), false);
        assert.equal(Object.hasOwn(item, "planIds"), false);
        const full = fullPage.data.items.find((candidate) => candidate.id === item.id)!;
        for (const [key, value] of Object.entries(item)) assert.deepEqual(value, full[key], key);
      }
      const fullBytes = Buffer.byteLength(normal.stdout);
      const compactBytes = Buffer.byteLength(compact.stdout);
      assert.ok(compactBytes < fullBytes / 4, `${compactBytes} / ${fullBytes}`);
      t.diagnostic(`${mode}: release list full=${fullBytes}, compact=${compactBytes} байт JSON`);
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const args: Array<string | number> = cursor
          ? ["release", "list", "--cursor", cursor]
          : [
              "release",
              "list",
              "--projection",
              "compact",
              "--q",
              "ОписаниеТолькоМаркер",
              "--status",
              "planned",
              "--limit",
              1,
            ];
        const page = successful(await json(args));
        assert.equal(page.data.total, 2);
        assert.equal(page.meta?.page?.limit, 1);
        assert.equal(page.meta?.page?.consistency, "snapshot");
        assert.ok(page.data.items.every((item) => !Object.hasOwn(item, "description")));
        ids.push(...page.data.items.map((item) => item.id));
        cursor = page.meta?.page?.nextCursor ?? null;
      } while (cursor);
      assert.deepEqual(new Set(ids), new Set(releases.slice(0, 2).map((item) => item.id)));
      assert.equal(ids.length, 2);
      const defaultSearch = successful(
        await json(["release", "list", "--q", "ОписаниеТолькоМаркер", "--status", "planned"]),
      );
      assert.deepEqual(new Set(defaultSearch.data.items.map((item) => item.id)), new Set(ids));
      const text = await invokeRaw(
        root,
        [
          ...connection,
          "release",
          "list",
          "--projection",
          "compact",
          "--q",
          "ОписаниеТолькоМаркер",
        ],
        { env: { COLUMNS: "40" } },
      );
      assert.equal(text.code, 0, text.stdout + text.stderr);
      assert.equal(text.stderr, "");
      assert.match(text.stdout, /Проекция:\s*compact/);
      assert.match(text.stdout, /release get REL-/);
      assert.doesNotMatch(text.stdout, /Подробное содержание/);
      const release = releases[0]!;
      for (const base of [
        ["release", "plans", release.key],
        ["release", "preview", "--plans", ...plans.map((item) => item.key)],
      ]) {
        const full = successful(await json(base));
        const first = successful(await json([...base, "--projection", "compact", "--limit", 1]));
        assert.deepEqual(first.data.readiness, full.data.readiness);
        assert.equal(first.data.items[0]?.plan.goal, undefined);
        assert.equal(full.data.items[0]?.plan.goal, goal);
        assert.ok(first.meta?.page?.nextCursor);
        const nextBase = base[1] === "plans" ? base : ["release", "preview"];
        const next = successful(await json([...nextBase, "--cursor", first.meta.page.nextCursor]));
        assert.equal(next.data.items[0]?.plan.key, plans[1]!.key);
        assert.equal(next.data.items[0]?.plan.goal, undefined);
        assert.deepEqual(next.data.readiness, full.data.readiness);
        assert.equal(next.meta?.page?.limit, 1);
      }
      const current = successful(await json<ReleaseSummary>(["release", "get", release.key])).data;
      assert.equal(current.description, description);
      assert.deepEqual(
        current.planIds,
        plans.map((item) => item.id),
      );
      const first = successful(
        await json(["release", "list", "--projection", "compact", "--limit", 1]),
      );
      assert.ok(first.meta?.page?.nextCursor);
      successful(
        await json([
          "release",
          "update",
          release.key,
          "--summary",
          "Изменено",
          "--if-revision",
          release.revision,
        ]),
      );
      failed(
        await json(["release", "list", "--cursor", first.meta.page.nextCursor]),
        "PLANNING_CHANGED",
        4,
      );
    },
  );

test(
  "REL-04 HTTP: server refs дают постоянное число запросов и исходный CAS",
  { timeout: 120_000 },
  async (t) => {
    const { root, run } = await fixture(t);
    const plans: PlanningSaved[] = [];
    for (let index = 0; index < 3; index++)
      plans.push(
        successful(await run<PlanningSaved>(["plan", "create", "--title", `План ${index}`])).data,
      );
    const server = await httpServer(t, root);
    const requests: Array<{ method: string; path: string; body?: unknown; bytes: number }> = [];
    const proxy = await httpProxy(t, async (request, response, signal) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const upstream = await fetch(`${server.url}${request.url}`, {
        signal,
        method: request.method ?? "GET",
        headers: { "content-type": "application/json" },
        ...(body.length ? { body } : {}),
      });
      const result = await upstream.text();
      requests.push({
        method: request.method ?? "GET",
        path: request.url!,
        ...(body.length ? { body: JSON.parse(body.toString()) } : {}),
        bytes: Buffer.byteLength(result),
      });
      response.writeHead(upstream.status, { "content-type": "application/json" });
      response.end(result);
    });
    const json = <T = unknown>(args: Array<string | number>) =>
      invoke<T>(root, ["--server-url", proxy.url, ...args]);
    const counts: number[] = [];
    for (const refs of [
      [plans[0]!.key],
      [plans[0]!.id, plans[1]!.key, `work-plan:${plans[2]!.id}`],
    ]) {
      requests.length = 0;
      const saved = successful(
        await json<PlanningSaved>([
          "release",
          "create",
          "--title",
          "Серверные ссылки",
          "--release-version",
          "same",
          "--plans",
          ...refs,
          "--description",
          "Сохранить полный текст",
        ]),
      ).data;
      counts.push(requests.length);
      assert.equal(requests.length, 2, JSON.stringify(requests));
      assert.equal(requests.filter((request) => request.method === "POST").length, 1);
      assert.ok(requests.every((request) => !request.path.includes("/entities/resolve")));
      const read = successful(await json<ReleaseSummary>(["release", "get", saved.key])).data;
      assert.deepEqual(
        read.planIds,
        plans.slice(0, refs.length).map((item) => item.id),
      );
    }
    t.diagnostic(`HTTP create N=1/N=3: ${counts.join("/")} запросов (включая context)`);
    requests.length = 0;
    const updated = successful(
      await json<PlanningSaved>([
        "release",
        "update",
        "REL-1",
        "--plans",
        ...plans.map((item) => `work-plan:${item.id}`),
        "--if-revision",
        1,
      ]),
    ).data;
    assert.equal(requests.length, 3, JSON.stringify(requests));
    assert.ok(requests.every((request) => !request.path.includes("/entities/resolve")));
    const before = successful(await json<ReleaseSummary>(["release", "get", "REL-1"])).data;
    assert.equal(before.description, "Сохранить полный текст");
    assert.deepEqual(
      before.planIds,
      plans.map((item) => item.id),
    );
    requests.length = 0;
    failed(
      await json(["release", "update", "REL-1", "--plans", plans[0]!.key, "--if-revision", 1]),
      "REVISION_CONFLICT",
      4,
    );
    assert.equal(requests.filter((request) => request.method === "POST").length, 1);
    assert.deepEqual(successful(await json(["release", "get", "REL-1"])).data, before);
    const duplicate = await json([
      "release",
      "update",
      "REL-1",
      "--plans",
      plans[0]!.key,
      `work-plan:${plans[0]!.id}`,
      "--if-revision",
      updated.revision,
    ]);
    assert.notEqual(duplicate.code, 0);
    assert.deepEqual(successful(await json(["release", "get", "REL-1"])).data, before);
    const wrongKind = await json([
      "release",
      "update",
      "REL-1",
      "--plans",
      "REL-2",
      "--if-revision",
      updated.revision,
    ]);
    assert.notEqual(wrongKind.code, 0);
    assert.deepEqual(successful(await json(["release", "get", "REL-1"])).data, before);
  },
);

test("REL-03 help: projection без проекта и отказ неизвестного режима", async (t) => {
  const root = await tempDirectory(t);
  for (const command of ["list", "plans", "preview"]) {
    const result = await invokeRaw(root, ["release", command, "--help"]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /--projection/);
    assert.match(result.stdout, /compact/);
  }
  const invalid = await invokeRaw(root, ["release", "list", "--projection", "unknown"]);
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stdout, /compact/);
  assert.doesNotMatch(invalid.stdout, /CONFIG_NOT_FOUND/);
});
