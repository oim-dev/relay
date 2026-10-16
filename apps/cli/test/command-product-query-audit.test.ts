import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { startServer } from "@relay/server-runtime";
import { ProductQueries } from "@relay/core/application/product/queries";
import { openWorkspace } from "@relay/core/storage/workspace";
import { AppError } from "@relay/core/shared/errors";
import type { ProductContext, ProductState } from "@relay/contracts/entities/product";
import type { ProductLintPage, ProductOverviewMapPage } from "@relay/contracts/product-query";
import type { ProductOverviewView } from "../src/presentation/product.js";
import {
  binary,
  cliEnv,
  cliNodeArgs,
  failed,
  fixtureCleanup,
  invoke,
  invokeRaw,
  successful,
  tempDirectory,
} from "./helpers/cli.js";
import { httpProxy } from "./helpers/http.js";

const markdown =
  "\n\n## Требования 世界 🧭\n\n\tотступ\n\n```text\n  строка кода без изменений\n```\n\nКонец паспорта.\n\n";
const unstructured = "Неструктурированный текст ".repeat(20);
type Saved = { key: string; ref: { id: string }; revision: number };

async function prepared(t: TestContext) {
  const root = join(await tempDirectory(t), "продукт с 'кавычкой'");
  await mkdir(root);
  const config = join(root, ".relay/config.json");
  const run = <T = unknown>(args: (string | number)[], input?: string) =>
    invoke<T>(root, ["--config", config, ...args], input === undefined ? {} : { input });
  successful(await invoke(root, ["init"]));
  successful(
    await run([
      "product",
      "create",
      "--name",
      "Память 世界 🧭",
      "--summary",
      "Назначение продукта",
      "--description",
      markdown,
    ]),
  );
  const feature = successful(
    await run<Saved>(["feature", "create", "--name", "Поиск", "--description", unstructured]),
  ).data;
  const other = successful(
    await run<Saved>(
      ["feature", "create", "--name", "Другая область", "--description-file", "-"],
      "Результат: Неструктурированный\n" + "Длинное чужое содержание ".repeat(4000),
    ),
  ).data;
  const application = successful(
    await run<Saved>([
      "application",
      "create",
      "--name",
      "Web",
      "--slug",
      "web",
      "--description",
      "Интерфейс",
    ]),
  ).data;
  const implementation = successful(
    await run<Saved>([
      "implementation",
      "create",
      "--application",
      application.key,
      "--target",
      feature.key,
      "--title",
      "Вклад Web",
      "--description",
      unstructured,
    ]),
  ).data;
  const task = successful(
    await run<Saved>([
      "task",
      "create",
      "--board",
      "product",
      "--title",
      "Проверить поиск",
      "--column",
      "review",
    ]),
  ).data;
  return { root, config, run, feature, other, application, implementation, task };
}

/** Подсказка исполняется целиком оболочкой; npx не обращается к сети. */
async function hints(t: TestContext, cwd: string) {
  const dir = await tempDirectory(t);
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  await writeFile(
    join(dir, "npx"),
    `#!/bin/sh\n[ "$1" = "@oim-dev/relay-cli" ] || exit 97\nshift\nexec ${[process.execPath, ...cliNodeArgs, binary].map(quote).join(" ")} "$@"\n`,
  );
  await chmod(join(dir, "npx"), 0o755);
  return async (command: string, format: "json" | "text" = "json") => {
    try {
      const result = await promisify(execFile)("bash", ["-c", command], {
        cwd,
        env: cliEnv({ PATH: `${dir}:${process.env.PATH}` }),
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      assert.equal(result.stderr, "");
      return {
        code: 0,
        stdout: result.stdout,
        body: format === "json" ? JSON.parse(result.stdout) : undefined,
      };
    } catch (error) {
      const result = error as Error & { code: number; stdout: string; stderr: string };
      assert.equal(result.stderr, "");
      return {
        code: result.code,
        stdout: result.stdout,
        body: format === "json" ? JSON.parse(result.stdout) : undefined,
      };
    }
  };
}

test("PROD help: state/context/view/snapshot доступны без проекта", async (t) => {
  const cwd = await tempDirectory(t);
  for (const name of ["state", "context", "overview", "lint"]) {
    const result = await invokeRaw(cwd, ["product", name, "--help"]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Примеры:/);
    if (name === "overview") {
      assert.match(result.stdout, /--snapshot/);
      assert.match(result.stdout, /--view/);
      assert.match(result.stdout, /compact.*full или\s+map/);
    }
  }
});

test("PROD-01…06 local: снимок, адреса, контекст, полнота и компактное представление", async (t) => {
  const app = await prepared(t);
  const executeHint = await hints(t, app.root);
  const overview = successful(
    await app.run<ProductOverviewView>(["product", "overview", "--limit", 1]),
  );
  assert.equal(overview.data.total, 5);
  assert.equal(overview.meta?.page?.count, 1);
  assert.equal(overview.data.snapshot.tasks.total, 1);
  const metricCommand = overview.data.commands.metrics["review-obligations-met"];
  assert.ok(metricCommand.endsWith(`--snapshot ${overview.data.snapshotVersion}`));
  const metric = await executeHint(metricCommand);
  assert.equal(metric.code, 0, metric.stdout);
  assert.equal(metric.body.data.total, 1);
  assert.equal((await executeHint(metric.body.data.commands.read)).body.data.key, app.task.key);

  const state = successful(await app.run<ProductState>(["product", "state"]));
  assert.equal(state.data.records.length, 5);
  assert.equal(state.meta?.page, undefined);
  assert.equal(
    state.data.records.find((r) => r.fields.kind === "passport")?.fields.kind,
    "passport",
  );
  const selected = successful(
    await app.run<ProductContext>([
      "product",
      "context",
      "--id",
      app.feature.key,
      "--application",
      app.application.key,
    ]),
  );
  assert.ok(selected.data.records.every((entry) => entry.reasons.length));
  assert.ok(selected.data.records.some(({ record }) => record.id === app.feature.ref.id));
  assert.ok(!selected.data.records.some(({ record }) => record.id === app.other.ref.id));
  assert.ok(
    selected.data.records.some(
      ({ record }) =>
        record.fields.kind === "scope" &&
        record.fields.contracts.some((entry) => entry.key === app.implementation.key),
    ),
  );
  // PROD-03c: единый каталог ищет описание до пагинации, нового product list нет.
  for (const prefix of [
    ["feature", "list"],
    ["search", "--kind", "feature"],
  ]) {
    const first = successful(
      await app.run<{ items: { key: string }[]; total: number }>([
        ...prefix,
        "--q",
        "Неструктурированный",
        "--limit",
        1,
      ]),
    );
    assert.equal(first.data.total, 2);
    const second = await executeHint(first.meta!.page!.nextCommand!);
    assert.equal(second.code, 0, second.stdout);
    assert.deepEqual(
      [...first.data.items, ...second.body.data.items].map((item) => item.key).sort(),
      [app.feature.key, app.other.key].sort(),
    );
  }
  const lint = successful(
    await app.run<ProductLintPage>(["product", "lint", "--id", app.implementation.key]),
  );
  assert.equal(lint.data.total, 1);
  assert.equal(lint.data.records, 1);
  assert.equal(lint.data.warnings[0]?.key, app.implementation.key);
  assert.equal(lint.data.warnings[0]?.canonicalRef, app.implementation.key);
  assert.equal(lint.data.warnings[0]?.ref.kind, "implementation");
  assert.match(lint.data.warnings[0]!.field, /^contracts\..+\.description$/);
  assert.notEqual(lint.data.warnings[0]?.recordId, app.implementation.ref.id);
  const lintMeta = lint.meta as { commands: { command: string }[] };
  assert.equal(
    (await executeHint(lintMeta.commands[0]!.command)).body.data.key,
    app.implementation.key,
  );

  const map = successful(
    await app.run<ProductOverviewMapPage>([
      "product",
      "overview",
      "--view",
      "map",
      "--snapshot",
      overview.data.snapshotVersion,
      "--limit",
      1,
    ]),
  );
  const all = [...map.data.items];
  let next = map.meta!.page!.nextCommand;
  while (next) {
    const page = await executeHint(next);
    assert.equal(page.code, 0, page.stdout);
    assert.equal(page.body.data.total, 5);
    assert.equal(page.body.data.snapshot, undefined);
    all.push(...page.body.data.items);
    next = page.body.meta.page.nextCommand;
  }
  assert.equal(all.length, 5);
  assert.equal(new Set(all.map((item) => item.id)).size, 5);
  assert.equal(all.find((item) => item.kind === "scope")?.subject.key, app.application.key);
  const directMap = successful(
    await app.run<ProductOverviewMapPage>(["product", "overview", "--view", "map"]),
  );
  const mapHints = directMap.meta as { commands: { command: string }[] };
  const participation = mapHints.commands.find((entry) =>
    entry.command.includes("application participation list"),
  );
  assert.ok(participation);
  assert.equal((await executeHint(participation.command)).code, 0);

  for (const width of [24, 40, 100, 160]) {
    const env = { COLUMNS: String(width), FORCE_COLOR: "1" };
    for (const args of [["state"], ["context", "--id", app.application.key]]) {
      const out = await invokeRaw(app.root, ["product", ...args], { env });
      assert.equal(out.code, 0, out.stdout);
      assert.equal(out.stderr, "");
      assert.ok(out.stdout.includes(markdown), out.stdout.slice(0, 500));
      assert.match(out.stdout, /не\s+полный\s+граф/);
      assert.doesNotMatch(out.stdout, /\u001b/);
    }
    const compact = await invokeRaw(app.root, ["product", "overview"], { env });
    const full = await invokeRaw(app.root, ["product", "overview", "--view", "full"], { env });
    assert.equal(compact.code, 0, compact.stdout);
    assert.equal(full.code, 0, full.stdout);
    assert.ok(
      compact.stdout.length < full.stdout.length * 0.65,
      `${width}: compact=${compact.stdout.length}, full=${full.stdout.length}`,
    );
    assert.match(compact.stdout, /Задач всего: 1/);
    assert.match(compact.stdout, /review 1/);
    assert.ok(compact.stdout.includes(overview.data.snapshotVersion));
    assert.doesNotMatch(compact.stdout, /^npx /m);
    assert.doesNotMatch(compact.stdout, /Показано:|Конец списка|Проверить поиск/);
    assert.match(full.stdout, /Требует внимания/);
    const mapText = await invokeRaw(app.root, ["product", "overview", "--view", "map"], { env });
    assert.equal(mapText.code, 0, mapText.stdout);
    assert.match(mapText.stdout, /WEB/);
    assert.doesNotMatch(mapText.stdout, /application participation list WEB/);
    assert.doesNotMatch(mapText.stdout, /Требует внимания|Задач всего|Показатели работы/);
    if (width === 40 || width === 100)
      t.diagnostic(
        JSON.stringify({
          width,
          filled: true,
          compact: {
            lines: compact.stdout.split("\n").length - 1,
            bytes: Buffer.byteLength(compact.stdout),
          },
          full: {
            lines: full.stdout.split("\n").length - 1,
            bytes: Buffer.byteLength(full.stdout),
          },
          map: {
            lines: mapText.stdout.split("\n").length - 1,
            bytes: Buffer.byteLength(mapText.stdout),
          },
        }),
      );
  }
  const compactJson = successful(
    await app.run<ProductOverviewView>(["product", "overview", "--view", "compact", "--limit", 1]),
  );
  assert.deepEqual(compactJson.data.snapshot, overview.data.snapshot);
  assert.equal(compactJson.data.total, overview.data.total);
  const oldHumanPage = await invokeRaw(app.root, [
    "--config",
    app.config,
    "product",
    "overview",
    "--cursor",
    overview.meta!.page!.nextCursor!,
  ]);
  assert.equal(oldHumanPage.code, 0, oldHumanPage.stdout);
  assert.doesNotMatch(oldHumanPage.stdout, /Требует внимания|Задач всего/);
  failed(
    await app.run(["product", "overview", "--metric", "board-work", "--view", "map"]),
    "INVALID_ARGUMENT",
  );
  failed(await app.run(["product", "overview", "--view", "invalid"]), "INVALID_ARGUMENT");
  failed(
    await app.run([
      "product",
      "overview",
      "--view",
      "full",
      "--cursor",
      map.meta!.page!.nextCursor!,
    ]),
    "INVALID_CURSOR",
  );

  const lintFirst = successful(await app.run<ProductLintPage>(["product", "lint", "--limit", 1]));
  const metricFirst = successful(
    await app.run([
      "product",
      "overview",
      "--metric",
      "board-work",
      "--snapshot",
      overview.data.snapshotVersion,
      "--limit",
      1,
    ]),
  );
  failed(
    await app.run([
      "product",
      "overview",
      "--snapshot",
      "другой-срез",
      "--cursor",
      metricFirst.meta!.page!.nextCursor!,
    ]),
    "INVALID_CURSOR",
  );
  successful(
    await app.run([
      "task",
      "update",
      app.task.key,
      "--title",
      "Другая задача",
      "--if-revision",
      app.task.revision,
    ]),
  );
  failed(
    await app.run(["product", "overview", "--cursor", overview.meta!.page!.nextCursor!]),
    "VERSION_CONFLICT",
    4,
  );
  failed(
    await app.run(["product", "overview", "--cursor", map.meta!.page!.nextCursor!]),
    "VERSION_CONFLICT",
    4,
  );
  const staleHint = await executeHint(metricCommand);
  failed(
    await app.run(["product", "overview", "--cursor", metricFirst.meta!.page!.nextCursor!]),
    "VERSION_CONFLICT",
    4,
  );
  assert.equal(staleHint.code, 4, staleHint.stdout);
  assert.equal(staleHint.body.error.code, "VERSION_CONFLICT");
  successful(
    await app.run([
      "feature",
      "update",
      app.feature.key,
      "--name",
      "Уточнение",
      "--if-revision",
      app.feature.revision,
    ]),
  );
  failed(
    await app.run(["product", "lint", "--cursor", lintFirst.meta!.page!.nextCursor!]),
    "VERSION_CONFLICT",
    4,
  );
  successful(await app.run(["product", "overview"]));
  successful(await app.run(["product", "lint"]));
});

test("PROD recovery: VERSION_CONFLICT сохраняет JSON и даёт исполняемое новое чтение local", async (t) => {
  const app = await prepared(t);
  // Другая cwd доказывает сохранение явного config, а не случайное чтение той же базы.
  const executeHint = await hints(t, await tempDirectory(t));
  const overview = successful(
    await app.run<ProductOverviewView>(["product", "overview", "--limit", 1]),
  );
  const map = successful(
    await app.run<ProductOverviewMapPage>(["product", "overview", "--view", "map", "--limit", 1]),
  );
  const metric = successful(
    await app.run([
      "product",
      "overview",
      "--metric",
      "board-work",
      "--snapshot",
      overview.data.snapshotVersion,
      "--limit",
      1,
    ]),
  );
  const lint = successful(
    await app.run<ProductLintPage>(["product", "lint", "--id", app.feature.key, "--limit", 1]),
  );
  assert.equal(lint.data.total, 2);
  successful(
    await app.run([
      "feature",
      "update",
      app.feature.key,
      "--name",
      "Изменено после чтения",
      "--if-revision",
      app.feature.revision,
    ]),
  );
  const core = new ProductQueries(await openWorkspace(app.root));
  const expectedFailure = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "VERSION_CONFLICT");
      return {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      };
    }
    assert.fail("Ожидался конфликт Core");
  };
  const cases = [
    {
      args: ["product", "overview", "--cursor", overview.meta!.page!.nextCursor!],
      restart: "product overview",
    },
    {
      args: ["product", "overview", "--cursor", map.meta!.page!.nextCursor!],
      restart: "product overview",
      original: await expectedFailure(() =>
        core.overviewMap({ offset: 1, limit: 1, version: map.data.snapshotVersion }),
      ),
    },
    {
      args: ["product", "overview", "--cursor", metric.meta!.page!.nextCursor!],
      restart: "product overview",
      original: await expectedFailure(() =>
        core.overviewMetric({ metric: "board-work", version: overview.data.snapshotVersion }),
      ),
    },
    {
      args: [
        "product",
        "overview",
        "--metric",
        "board-work",
        "--snapshot",
        overview.data.snapshotVersion,
      ],
      restart: "product overview",
      original: await expectedFailure(() =>
        core.overviewMetric({ metric: "board-work", version: overview.data.snapshotVersion }),
      ),
    },
    // --id отсутствует в текущем argv: recovery должен восстановить его из курсора.
    {
      args: ["product", "lint", "--cursor", lint.meta!.page!.nextCursor!],
      restart: `product lint --id ${app.feature.key}`,
      original: await expectedFailure(() =>
        core.lint({ ref: app.feature.key, offset: 1, limit: 1, version: lint.data.version }),
      ),
    },
  ];
  for (const entry of cases) {
    const json = await app.run(entry.args);
    failed(json, "VERSION_CONFLICT", 4);
    if (entry.original && !json.body.ok) assert.deepEqual(json.body.error, entry.original);
    const human = await invokeRaw(app.root, ["--local", "--config", app.config, ...entry.args], {
      env: { COLUMNS: "24", FORCE_COLOR: "1" },
    });
    assert.equal(human.code, 4, human.stdout);
    assert.equal(human.stderr, "");
    assert.match(human.stdout, /VERSION_CONFLICT/);
    assert.match(human.stdout, /не\s+запускается\s+автоматически/);
    assert.doesNotMatch(human.stdout, /\u001b/);
    const commands = human.stdout.split("\n").filter((line) => line.startsWith("npx "));
    assert.equal(commands.length, 1, human.stdout);
    const command = commands[0]!;
    assert.ok(command.endsWith(entry.restart), command);
    assert.match(command, /--local --config /);
    assert.ok(command.includes("'\\''кавычкой'\\''"), command);
    assert.doesNotMatch(command, /--cursor|--snapshot|--metric|--view/);
    const actual = await executeHint(command, "text");
    assert.equal(actual.code, 0, actual.stdout);
    assert.match(
      actual.stdout,
      entry.restart.includes("lint") ? /Качество содержания/ : /Память 世界 🧭/,
    );
  }
});

test("PROD-03 state: local/HTTP DTO равен Core, включая Markdown, FI, снятую SI и документ", async (t) => {
  const app = await prepared(t);
  const scenario = successful(
    await app.run<Saved>([
      "scenario",
      "create",
      "--feature",
      app.feature.key,
      "--name",
      "Найти",
      "--description",
      markdown,
    ]),
  ).data;
  const siBody = markdown.replace("паспорта", "реализации SI");
  const si = successful(
    await app.run<Saved>([
      "implementation",
      "create",
      "--application",
      app.application.key,
      "--target",
      scenario.key,
      "--title",
      "Вклад сценария",
      "--description",
      siBody,
    ]),
  ).data;
  const documentBody = markdown.replace("паспорта", "архивного документа");
  const document = successful(
    await app.run<Saved>([
      "document",
      "create",
      "--name",
      "Основание",
      "--body",
      documentBody,
      "--document-status",
      "archived",
      "--relations",
      JSON.stringify([
        {
          type: "documents",
          target: { kind: "feature", id: app.feature.ref.id },
          description: "Полное пояснение\n\n  без усечения",
        },
      ]),
    ]),
  ).data;
  const core = new ProductQueries(await openWorkspace(app.root));
  const composition = await core.participation({ application: app.application.key });
  await core.replaceParticipation(
    {
      application: app.application.key,
      selections: [{ kind: "existing", ref: app.implementation.key }],
      ifRevision: composition.revision,
      ifVersion: composition.version,
      requestId: "state-parity-withdraw-si",
    },
    "test-agent",
  );
  const expected = await core.state();
  const received = successful(await app.run<ProductState>(["product", "state"]));
  assert.deepEqual(
    received.data,
    expected,
    "Весь DTO без выкинутых записей, полей, тел или readiness",
  );
  const scope = received.data.records.find((entry) => entry.fields.kind === "scope");
  assert.ok(scope?.fields.kind === "scope");
  const fiRecord = scope.fields.contracts.find((entry) => entry.key === app.implementation.key);
  const siRecord = scope.fields.contracts.find((entry) => entry.key === si.key);
  assert.equal(fiRecord?.description, unstructured);
  assert.equal(fiRecord?.active, true);
  assert.equal(siRecord?.description, siBody);
  assert.equal(siRecord?.active, false);
  assert.equal(siRecord?.scenarioId, scenario.ref.id);
  const doc = received.data.records.find((entry) => entry.key === document.key);
  assert.ok(doc?.fields.kind === "document");
  assert.equal(doc.fields.body, documentBody);
  assert.equal(doc.fields.documentStatus, "archived");
  assert.equal(doc.fields.relations?.[0]?.description, "Полное пояснение\n\n  без усечения");
  const server = await startServer({ cwd: app.root, actor: "test-agent", port: 0 });
  fixtureCleanup(t, () => server.close());
  const remote = successful(
    await app.run<ProductState>(["--server-url", server.url, "product", "state"]),
  );
  assert.deepEqual(
    remote.data,
    expected,
    "Полное состояние HTTP совпадает с Core и local без исключения тел или inactive",
  );
  const expectedContext = await core.context({ id: si.key });
  const localContext = successful(
    await app.run<ProductContext>(["product", "context", "--id", si.key]),
  );
  const remoteContext = successful(
    await app.run<ProductContext>([
      "--server-url",
      server.url,
      "product",
      "context",
      "--id",
      si.key,
    ]),
  );
  assert.deepEqual(localContext.data, expectedContext);
  assert.deepEqual(remoteContext.data, expectedContext);
  for (const width of [24, 40, 100, 160]) {
    const human = await invokeRaw(app.root, ["product", "state"], {
      env: { COLUMNS: String(width) },
    });
    assert.equal(human.code, 0, human.stdout);
    assert.ok(human.stdout.includes(siBody));
    assert.ok(human.stdout.includes(documentBody));
    assert.ok(human.stdout.includes("Полное пояснение\n\n  без усечения"));
    assert.match(human.stdout, /Участие:\s+снято/);
  }
});

test("PROD-05: пустой обзор компактен, полный режим доступен, totals карты не выдуманы", async (t) => {
  const root = await tempDirectory(t);
  successful(await invoke(root, ["init"]));
  for (const width of [40, 100]) {
    const compact = await invokeRaw(root, ["product", "overview"], {
      env: { COLUMNS: String(width) },
    });
    const full = await invokeRaw(root, ["product", "overview", "--view", "full"], {
      env: { COLUMNS: String(width) },
    });
    assert.equal(compact.code, 0, compact.stdout);
    assert.equal(full.code, 0, full.stdout);
    assert.match(compact.stdout, /Продукт без паспорта/);
    assert.match(compact.stdout, /Задач всего: 0/);
    assert.doesNotMatch(compact.stdout, /^npx /m);
    assert.match(compact.stdout, /Срез:/);
    assert.doesNotMatch(compact.stdout, /Показано:|Конец списка/);
    assert.ok(compact.stdout.length < full.stdout.length * 0.65);
    t.diagnostic(
      JSON.stringify({
        width,
        filled: false,
        compact: {
          lines: compact.stdout.split("\n").length - 1,
          bytes: Buffer.byteLength(compact.stdout),
        },
        full: { lines: full.stdout.split("\n").length - 1, bytes: Buffer.byteLength(full.stdout) },
      }),
    );
  }
  const map = successful(
    await invoke<ProductOverviewMapPage>(root, ["product", "overview", "--view", "map"]),
  );
  assert.equal(map.data.total, 0);
  assert.equal(map.meta?.page?.count, 0);
  assert.equal(map.meta?.page?.nextCursor, null);
  assert.equal(map.data.items.length, 0);
});

test("PROD HTTP: предметные операции не получают state ради validate/lint/map, guard и адреса", async (t) => {
  const app = await prepared(t);
  const server = await startServer({ cwd: app.root, actor: "test-agent", port: 0 });
  fixtureCleanup(t, () => server.close());
  const calls: { path: string; bytes: number; body: string }[] = [];
  const proxy = await httpProxy(t, async (req, res, signal) => {
    const upstream = await fetch(`${server.url}${req.url}`, { signal });
    const body = await upstream.text();
    calls.push({ path: req.url!, bytes: Buffer.byteLength(body), body });
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(body);
  });
  const remote = <T = unknown>(args: (string | number)[]) =>
    app.run<T>(["--server-url", proxy.url, ...args]);
  for (const args of [
    ["product", "validate"],
    ["product", "lint", "--id", app.implementation.key],
    ["product", "overview", "--view", "map", "--limit", 1],
  ]) {
    calls.length = 0;
    const local = successful(await app.run(args));
    const http = successful(await remote(args));
    assert.deepEqual(http.data, local.data);
    const productCalls = calls.filter((entry) => entry.path.includes("/product/"));
    assert.equal(productCalls.length, 1, JSON.stringify(calls));
    assert.ok(
      !productCalls.some((entry) => /\/state|\/entity/.test(entry.path)),
      JSON.stringify(calls),
    );
    assert.ok(productCalls[0]!.bytes < 5000, `${args}: ${productCalls[0]!.bytes}`);
    assert.doesNotMatch(productCalls[0]!.body, /Длинное чужое содержание/);
  }
  for (const args of [
    ["product", "state"],
    ["product", "context", "--id", app.application.key],
  ])
    assert.deepEqual(successful(await remote(args)).data, successful(await app.run(args)).data);
  const overview = successful(
    await remote<ProductOverviewView>(["product", "overview", "--limit", 1]),
  );
  const map = successful(
    await remote<ProductOverviewMapPage>(["product", "overview", "--view", "map", "--limit", 1]),
  );
  const lint = successful(await remote<ProductLintPage>(["product", "lint", "--limit", 1]));
  failed(
    await app.run(["--local", "product", "overview", "--cursor", map.meta!.page!.nextCursor!]),
    "INVALID_CURSOR",
  );
  const executeHint = await hints(t, app.root);
  const metric = await executeHint(overview.data.commands.metrics["review-obligations-met"]);
  assert.equal(metric.code, 0, metric.stdout);
  assert.equal((await executeHint(metric.body.data.commands.read)).body.data.key, app.task.key);
  successful(
    await app.run([
      "task",
      "update",
      app.task.key,
      "--title",
      "Новый срез",
      "--if-revision",
      app.task.revision,
    ]),
  );
  for (const cursor of [overview.meta!.page!.nextCursor!, map.meta!.page!.nextCursor!])
    failed(await remote(["product", "overview", "--cursor", cursor]), "VERSION_CONFLICT", 4);
  const stale = await executeHint(overview.data.commands.metrics["review-obligations-met"]);
  assert.equal(stale.code, 4, stale.stdout);
  assert.equal(stale.body.error.code, "VERSION_CONFLICT");
  successful(
    await app.run([
      "feature",
      "update",
      app.feature.key,
      "--name",
      "Новый lint",
      "--if-revision",
      app.feature.revision,
    ]),
  );
  failed(
    await remote(["product", "lint", "--cursor", lint.meta!.page!.nextCursor!]),
    "VERSION_CONFLICT",
    4,
  );
});
