import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntitySaved } from "@relay/contracts/entities";
import type { TaskDependenciesPage, TaskProgress } from "@relay/contracts/progress";
import { failed, fixture, invokeRaw, successful } from "./helpers/cli.js";
import { httpProxy, httpServer } from "./helpers/http.js";

test(
  "TASK-04: compact — отдельный транспорт, совместимый full JSON и раздельные guards local/HTTP",
  { timeout: 180_000 },
  async (t) => {
    const { root, run } = await fixture(t);
    const create = async (title: string, args: (string | number)[] = []) =>
      successful(
        await run<EntitySaved>(["task", "create", "--board", "product", "--title", title, ...args]),
      ).data;
    const done = await create("Выполненная зависимость", ["--column", "done"]);
    const reopened = await create("Зависимость done с открытым ребёнком");
    const child = await create("Повторно открываемый ребёнок", [
      "--parent",
      reopened.key,
      "--column",
      "done",
    ]);
    successful(
      await run([
        "task",
        "move",
        reopened.key,
        "--column",
        "done",
        "--if-revision",
        reopened.revision,
      ]),
    );
    successful(
      await run(["task", "move", child.key, "--column", "review", "--if-revision", child.revision]),
    );
    const cancelled = await create("Отменённая зависимость", ["--column", "cancelled"]);
    const owner = await create("Владелец зависимостей", [
      "--dependencies",
      cancelled.key,
      reopened.key,
      done.key,
      "--criterion-title",
      "a=Первое условие",
      "--criterion-title",
      "b=Второе условие",
    ]);
    await create("Собственная подзадача", ["--parent", owner.key]);
    const server = await httpServer(t, root);
    const requests: string[] = [];
    const proxy = await httpProxy(t, async (request, response) => {
      requests.push(request.url ?? "");
      const result = await fetch(`${server.url}${request.url}`, {
        method: request.method ?? "GET",
      });
      response.statusCode = result.status;
      response.setHeader("Content-Type", result.headers.get("Content-Type") ?? "application/json");
      response.end(Buffer.from(await result.arrayBuffer()));
    });
    for (const transport of [["--local"], ["--server-url", proxy.url]]) {
      const command = [...transport, "task", "dependency", "list", owner.key];
      requests.length = 0;
      const full = successful(await run<TaskProgress>([...command, "--limit", 100]));
      const fullRequest = requests.filter((url) => url.includes("/progress/"));
      assert.ok(
        full.data.criteria.total > 0 && full.data.children.total > 0 && full.data.reasons.total > 0,
        "Прежний JSON не сокращён",
      );
      requests.length = 0;
      const compact = successful(
        await run<TaskDependenciesPage>([...command, "--projection", "compact", "--limit", 100]),
      );
      assert.deepEqual(Object.keys(compact.data).sort(), [
        "entity",
        "items",
        "nextOffset",
        "total",
        "version",
      ]);
      assert.deepEqual(compact.data.items, full.data.dependencies.items);
      assert.deepEqual(compact.data.entity, full.data.entity);
      assert.equal(compact.data.total, 3);
      assert.deepEqual(Object.fromEntries(compact.data.items.map((x) => [x.id, x.completed])), {
        [done.ref.id]: true,
        [reopened.ref.id]: false,
        [cancelled.ref.id]: false,
      });
      if (transport.includes("--server-url")) {
        const narrowRequest = requests.filter((url) => url.includes("/progress/"));
        assert.equal(fullRequest.length, 1, "Один предметный запрос full");
        assert.equal(narrowRequest.length, 1, "Один предметный запрос compact без fallback");
        assert.notEqual(
          new URL(fullRequest[0]!, proxy.url).pathname,
          new URL(narrowRequest[0]!, proxy.url).pathname,
          "Compact вызывает отдельный серверный API, а не обрезает DTO в CLI",
        );
      }
      const first = successful(
        await run<TaskDependenciesPage>([...command, "--projection", "compact", "--limit", 1]),
      );
      const old = successful(await run<TaskProgress>([...command, "--limit", 1]));
      assert.ok(first.meta?.page?.nextCursor && old.meta?.page?.nextCursor);
      assert.match(first.meta.page.nextCommand!, /--projection compact/);
      assert.match(old.meta.page.nextCommand!, /--projection full/);
      failed(
        await run([...command, "--projection", "full", "--cursor", first.meta.page.nextCursor]),
        "INVALID_CURSOR",
      );
      failed(
        await run([...command, "--projection", "compact", "--cursor", old.meta.page.nextCursor]),
        "INVALID_CURSOR",
      );
      // Исторический CLI wrapper не содержал projection: по-прежнему означает full.
      const legacyCursor = JSON.parse(
        Buffer.from(old.meta.page.nextCursor, "base64url").toString("utf8"),
      );
      delete legacyCursor.filters.projection;
      const legacy = successful(
        await run<TaskProgress>([
          ...command,
          "--cursor",
          Buffer.from(JSON.stringify(legacyCursor)).toString("base64url"),
        ]),
      );
      assert.ok("criteria" in legacy.data && "dependencies" in legacy.data);
      assert.match(legacy.meta!.page!.nextCommand!, /--projection full/);
      const wrongGuard = { ...legacyCursor, filters: { projection: "compact" } };
      const rejected = await run([
        ...command,
        "--cursor",
        Buffer.from(JSON.stringify(wrongGuard)).toString("base64url"),
      ]);
      assert.ok(!rejected.body.ok, rejected.stdout);
      assert.match(
        rejected.body.error.code,
        /CHANGED|CONFLICT/,
        "Версия full не становится версией compact даже при подмене метки в wrapper",
      );
      const seen = [...first.data.items];
      let cursor = first.meta.page.nextCursor;
      while (cursor) {
        // Проекцию восстанавливает курсор, в том числе при смене human ↔ JSON.
        const human = await invokeRaw(root, [...command, "--cursor", cursor]);
        assert.equal(human.code, 0, human.stdout + human.stderr);
        assert.equal(human.stderr, "");
        assert.doesNotMatch(human.stdout, /Критерии приёмки|Причины ·|\u001b/);
        const page = successful(await run<TaskDependenciesPage>([...command, "--cursor", cursor]));
        assert.equal(page.data.version, first.data.version);
        assert.equal(page.meta?.page?.count, page.data.items.length);
        assert.equal(page.meta?.page?.total, 3);
        assert.ok(!("criteria" in page.data));
        seen.push(...page.data.items);
        cursor = page.meta?.page?.nextCursor ?? "";
      }
      assert.deepEqual(
        seen,
        compact.data.items,
        "Все ID, порядок и фактическое выполнение без пропусков",
      );
      const before = successful(await run<{ revision: number }>(["task", "get", owner.key])).data;
      successful(
        await run([
          "task",
          "update",
          owner.key,
          "--title",
          `Изменение для guard ${transport[0]}`,
          "--if-revision",
          before.revision,
        ]),
      );
      const stale = await run([...command, "--cursor", first.meta.page.nextCursor]);
      assert.ok(!stale.body.ok, stale.stdout);
      assert.match(stale.body.error.code, /CHANGED|CONFLICT/);
    }
    const help = await invokeRaw(root, ["task", "dependency", "list", "--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /--projection/);
    assert.match(help.stdout, /compact/);
  },
);
