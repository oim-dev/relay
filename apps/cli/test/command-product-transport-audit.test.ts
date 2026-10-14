import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntityDetail, EntitySaved } from "@relay/contracts/entities";
import type {
  ProductParticipationPage,
  ProductParticipationSaved,
} from "@relay/contracts/product-participation";
import { fixture, invoke, invokeRaw, successful, tempDirectory } from "./helpers/cli.js";
import { httpProxy, httpServer } from "./helpers/http.js";

test("APP-03/07 IMP-04/08: HTTP mixed existing FI + новые SI; legacy replace без N resolve", async (t) => {
  const f = await fixture(t);
  const create = async (kind: string, args: string[]) =>
    successful(await f.run<EntitySaved>([kind, "create", ...args])).data;
  const app = await create("application", [
    "--name",
    "Web",
    "--slug",
    "web",
    "--description",
    "Назначение",
  ]);
  const feature = await create("feature", ["--name", "Поиск", "--description", "Требования"]);
  const scenarios: EntitySaved[] = [];
  for (const name of ["Найти", "Выбрать"])
    scenarios.push(
      await create("scenario", ["--name", name, "--feature", feature.key, "--description", "Шаги"]),
    );
  const markdown = "\n## Вклад HTTP 界\n\n```text\n\t  пробелы\n```\n\nКОНЕЦ_HTTP\n\n";
  const fi = await create("implementation", [
    "--application",
    app.key,
    "--target",
    feature.key,
    "--title",
    "Общий вклад",
    "--description",
    markdown,
    "--status",
    "done",
  ]);
  successful(
    await f.run([
      "task",
      "create",
      "--board",
      "web",
      "--title",
      "Готовая прямая работа",
      "--targets",
      fi.key,
      "--column",
      "done",
    ]),
  );
  const server = await httpServer(t, f.root);
  const requests: { method: string; url: string; bytes: number }[] = [];
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
    const text = await upstream.text();
    requests.push({
      method: request.method ?? "GET",
      url: request.url!,
      bytes: Buffer.byteLength(text),
    });
    response.writeHead(upstream.status, { "content-type": "application/json" });
    response.end(text);
  });
  const client = await tempDirectory(t);
  const run = <T = unknown>(args: (string | number)[]) =>
    invoke<T>(client, ["--server-url", proxy.url, ...args]);
  const read = async () =>
    successful(
      await run<ProductParticipationPage>([
        "application",
        "participation",
        "list",
        app.key,
        "--projection",
        "compact",
      ]),
    ).data;
  const legacy = async (page: ProductParticipationPage, refs: string[], requestId: string) => {
    requests.length = 0;
    const data = successful(
      await run<{ id: string; key?: string; revision: number; requestId: string }>([
        "application",
        "participation",
        "replace",
        app.key,
        "--implementations",
        ...refs,
        "--if-revision",
        page.revision,
        "--if-version",
        page.version,
        "--request-id",
        requestId,
      ]),
    ).data;
    assert.equal(data.id, page.scopeId);
    assert.equal(data.requestId, requestId);
    assert.deepEqual(
      Object.keys(data).sort(),
      ["id", "revision", "requestId", ...(data.key ? ["key"] : [])].sort(),
    );
    assert.equal(requests.length, 2, JSON.stringify(requests));
    assert.equal(requests.filter((item) => item.method === "POST").length, 1);
    assert.ok(requests.every((item) => !/\/state|\/resolve|\/entities\/get/.test(item.url)));
    t.diagnostic(
      `legacy replace N=${refs.length}: ${requests.length} HTTP; ${requests.reduce((sum, item) => sum + item.bytes, 0)} байт ответов`,
    );
  };
  let page = await read();
  assert.equal(page.items[0]!.savedStatus, "done");
  assert.equal(page.items[0]!.status, "done");
  await legacy(page, [fi.key], "legacy-one");
  page = await read();
  const composition = [
    { kind: "existing", ref: fi.key },
    ...scenarios.map((scenario, index) => ({
      kind: "target",
      target: scenario.key,
      title: `Новый SI ${index}`,
      description: markdown,
    })),
  ];
  requests.length = 0;
  const saved = successful(
    await run<ProductParticipationSaved>([
      "application",
      "participation",
      "replace",
      app.key,
      "--composition",
      JSON.stringify(composition),
      "--if-revision",
      page.revision,
      "--if-version",
      page.version,
    ]),
  ).data;
  assert.equal(saved.selected, 3);
  assert.equal(requests.length, 2, JSON.stringify(requests));
  assert.equal(requests.filter((item) => item.method === "POST").length, 1);
  const readback = successful(await run<EntityDetail>(["implementation", "get", fi.key])).data;
  assert.equal(readback.savedStatus, "done");
  assert.equal(readback.status, "partial");
  assert.ok(
    readback.data.kind === "implementation" &&
      readback.data.status === "partial" &&
      readback.data.description === markdown,
  );
  assert.deepEqual(
    readback,
    successful(await f.run<EntityDetail>(["implementation", "get", fi.key])).data,
  );
  const human = await invokeRaw(client, [
    "--server-url",
    proxy.url,
    "implementation",
    "get",
    fi.key,
  ]);
  assert.equal(human.code, 0, human.stdout);
  assert.match(human.stdout, /Совместимая отметка: done/);
  assert.match(human.stdout, /Готовность \(расчёт\):\s*Частично/);
  assert.ok(human.stdout.includes(markdown));
  page = await read();
  assert.equal(page.total, 3);
  for (const item of page.items.filter((entry) => entry.implementationTarget === "scenario")) {
    const si = successful(await run<EntityDetail>(["implementation", "get", item.key])).data;
    assert.equal(si.active, true);
    assert.ok(si.data.kind === "implementation" && si.data.description === markdown);
  }
  const full = successful(
    await run<{ items: { description: string; basis: unknown }[] }>([
      "application",
      "participation",
      "list",
      app.key,
    ]),
  ).data;
  assert.ok(full.items.every((item) => item.description === markdown && "basis" in item));
  await legacy(
    page,
    page.items.map((item) => item.key),
    "legacy-three",
  );
  const after = successful(await run<EntityDetail>(["implementation", "get", fi.key])).data;
  assert.equal(after.savedStatus, "done");
  assert.equal(after.status, "partial");
  assert.deepEqual(after.data, readback.data);
  requests.length = 0;
  const first = successful(
    await run<ProductParticipationPage>([
      "application",
      "participation",
      "list",
      app.key,
      "--projection",
      "compact",
      "--limit",
      1,
    ]),
  );
  assert.equal(requests.length, 2);
  assert.equal(first.data.items.length, 1);
  assert.ok(!JSON.stringify(first.data).includes("КОНЕЦ_HTTP"));
  assert.ok(first.meta?.page?.nextCursor);
  successful(
    await run([
      "application",
      "participation",
      "list",
      app.key,
      "--cursor",
      first.meta.page.nextCursor,
    ]),
  );
});
