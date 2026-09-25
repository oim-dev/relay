import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";
import { buildBundle, checkBundle, lockPath, prepareBundle, repoRoot, sourceRoot } from "./lib.mjs";
import { fixture, readAgentMarkdown, readTomlString, snapshot } from "./testing.mjs";

const cli = (mode, root, ...args) =>
  spawnSync(
    process.execPath,
    [join(repoRoot, `packages/dev-agents/scripts/${mode}.mjs`), "--root", root, ...args],
    { encoding: "utf8" },
  );

test("девять профилей воспроизводятся побайтно независимо от порядка manifest; повтор не пишет файлы", async (t) => {
  const app = await fixture(t);
  const first = await prepareBundle(app.root);
  assert.equal(first.output.size, 29);
  app.manifest.agents.reverse();
  await app.saveManifest();
  const second = await prepareBundle(app.root);
  assert.deepEqual(second.output, first.output);
  assert.equal(second.lockText, first.lockText);
  assert.equal((await buildBundle({ root: app.root })).written.length, 30);
  const before = await snapshot(app.root);
  assert.equal((await checkBundle({ root: app.root })).ok, true);
  const again = await buildBundle({ root: app.root });
  assert.deepEqual(again.written, []);
  assert.deepEqual(again.removed, []);
  assert.deepEqual(await snapshot(app.root), before);
  const lock = JSON.parse(await readFile(join(app.root, lockPath), "utf8"));
  assert.equal(lock.version, 1);
  assert.equal(lock.outputs.length, 29);
  assert.equal("timestamp" in lock, false);
  for (const entry of lock.outputs) {
    assert.equal(
      entry.sha256,
      createHash("sha256").update(first.output.get(entry.path)).digest("hex"),
    );
  }
});

test("каждая роль передаётся целиком без встраивания root/local AGENTS и common", async (t) => {
  const app = await fixture(t);
  const first = await prepareBundle(app.root);
  const unrelated = {
    "AGENTS.md": "# Общие правила проекта\n\nМаркер ROOT_ONLY.\n",
    [`${sourceRoot}/AGENTS.md`]: "# Инструкции каталога\n\nМаркер LOCAL_ONLY.\n",
    [`${sourceRoot}/common.md`]: "# Прежний общий текст\n\nМаркер COMMON_ONLY.\n",
  };
  for (const [path, text] of Object.entries(unrelated)) await app.put(path, text);
  const second = await prepareBundle(app.root);
  assert.deepEqual(second.output, first.output);
  assert.equal(second.lockText, first.lockText);
  await buildBundle({ root: app.root });
  for (const [path, text] of Object.entries(unrelated)) {
    assert.equal(await readFile(join(app.root, path), "utf8"), text);
    assert.equal(second.output.has(path), false);
  }
  for (const agent of second.agents) {
    assert.equal(agent.body, app.prompts.get(agent.name));
    assert.match(agent.body, /Соблюдай общие правила корневого AGENTS\.md/);
    assert.doesNotMatch(agent.body, /ROOT_ONLY|LOCAL_ONLY|COMMON_ONLY/);
    for (const directory of [".opencode", ".claude"]) {
      const { body } = readAgentMarkdown(second.output.get(`${directory}/agents/${agent.name}.md`));
      assert.equal(body, agent.body);
    }
    const codexPath =
      agent.kind === "orchestrator" ? ".codex/config.toml" : `.codex/agents/${agent.name}.toml`;
    assert.equal(
      readTomlString(second.output.get(codexPath), "developer_instructions"),
      agent.body,
    );
  }
});

test("изменение профиля оркестратора обновляет только три его выхода и lock, не воркеров", async (t) => {
  const app = await fixture(t);
  await buildBundle({ root: app.root });
  const prompt = `${app.prompts.get("relay-orchestrator")}\n## Итог\n\nОтдельно перечисли непроверенное.\n`;
  await app.put(`${sourceRoot}/orchestrator.md`, prompt);
  const before = await snapshot(app.root);
  const primaryOutputs = [
    ".claude/agents/relay-orchestrator.md",
    ".codex/config.toml",
    ".opencode/agents/relay-orchestrator.md",
  ];
  const changedPaths = [...primaryOutputs, lockPath];
  const checked = await checkBundle({ root: app.root });
  assert.equal(checked.ok, false);
  assert.deepEqual(
    checked.issues.map(({ kind, path }) => ({ kind, path })),
    changedPaths.map((path) => ({ kind: "outdated", path })),
  );
  assert.deepEqual(await snapshot(app.root), before);
  const built = await buildBundle({ root: app.root });
  assert.deepEqual(built.written, changedPaths);
  assert.deepEqual(built.removed, []);
  const after = await snapshot(app.root);
  assert.deepEqual(Object.keys(after), Object.keys(before));
  assert.deepEqual(
    Object.keys(after).filter((path) => after[path].bytes !== before[path].bytes),
    changedPaths,
  );
  for (const path of Object.keys(before)) {
    if (!changedPaths.includes(path)) assert.deepEqual(after[path], before[path], path);
  }
  for (const path of primaryOutputs) {
    const content = await readFile(join(app.root, path), "utf8");
    const body = path.endsWith(".toml")
      ? readTomlString(content, "developer_instructions")
      : readAgentMarkdown(content).body;
    assert.equal(body, prompt);
  }
  assert.equal((await checkBundle({ root: app.root })).ok, true);
  const repeated = await buildBundle({ root: app.root });
  assert.deepEqual(repeated.written, []);
  assert.deepEqual(repeated.removed, []);
  assert.deepEqual(await snapshot(app.root), after);
});

test("старая сгенерированная CLAUDE.md удаляется только при подтверждённом владении в lock", async (t) => {
  const app = await fixture(t);
  await buildBundle({ root: app.root });
  const wrapper = "# Прежняя обёртка\n\n@AGENTS.md\n";
  await app.put("CLAUDE.md", wrapper);
  const lock = JSON.parse(await readFile(join(app.root, lockPath), "utf8"));
  lock.outputs.push({
    path: "CLAUDE.md",
    sha256: createHash("sha256").update(wrapper).digest("hex"),
  });
  await app.put(lockPath, JSON.stringify(lock));
  const checked = await checkBundle({ root: app.root });
  assert(checked.issues.some((issue) => issue.kind === "extra" && issue.path === "CLAUDE.md"));
  assert.deepEqual((await buildBundle({ root: app.root })).removed, ["CLAUDE.md"]);
  await assert.rejects(readFile(join(app.root, "CLAUDE.md")), { code: "ENOENT" });
  assert.equal((await checkBundle({ root: app.root })).ok, true);
});

test("check сообщает о первом отсутствии, drift источников, ручной правке и лишнем результате без записи", async (t) => {
  const app = await fixture(t);
  let before = await snapshot(app.root);
  let report = await checkBundle({ root: app.root });
  assert.equal(report.issues.filter((issue) => issue.kind === "missing").length, 30);
  assert.deepEqual(await snapshot(app.root), before);
  await buildBundle({ root: app.root });
  await app.put(`${sourceRoot}/backend.md`, "# Новый полный профиль\n");
  await app.put(".opencode/agents/relay-frontend.md", "Ручные изменения\n");
  await rm(join(app.root, ".claude/agents/relay-qa.md"));
  app.manifest.agents = app.manifest.agents.filter((agent) => agent.name !== "relay-cli");
  await app.saveManifest();
  before = await snapshot(app.root);
  report = await checkBundle({ root: app.root });
  assert.equal(report.ok, false);
  assert(
    report.issues.some(
      (issue) => issue.kind === "outdated" && issue.path === ".opencode/agents/relay-frontend.md",
    ),
  );
  assert(
    report.issues.some(
      (issue) => issue.kind === "missing" && issue.path === ".claude/agents/relay-qa.md",
    ),
  );
  assert.equal(report.issues.filter((issue) => issue.kind === "extra").length, 3);
  assert.deepEqual(await snapshot(app.root), before);
});

test("переименование и удаление агента убирают только три собственных выхода, сохраняя чужие настройки", async (t) => {
  const app = await fixture(t);
  await buildBundle({ root: app.root });
  const unrelated = {
    "AGENTS.md": "# Рукописные инструкции главного\n",
    "CLAUDE.md": "# Существующая личная обёртка\n",
    ".opencode/agents/personal.md": "# Личный агент\n",
    ".opencode/plugins/personal.ts": "// Личный плагин\n",
    ".claude/agents/personal.md": "# Личный агент\n",
    ".claude/settings.local.json": '{"language":"russian"}\n',
    ".codex/agents/personal.toml": 'name = "personal"\n',
    ".codex/personal.config.toml": "# Личные настройки\n",
  };
  for (const [path, text] of Object.entries(unrelated)) await app.put(path, text);
  app.manifest.agents.find((agent) => agent.name === "relay-core").name = "relay-engine";
  await app.saveManifest();
  const renamed = await buildBundle({ root: app.root });
  assert.deepEqual(renamed.removed, [
    ".claude/agents/relay-core.md",
    ".codex/agents/relay-core.toml",
    ".opencode/agents/relay-core.md",
  ]);
  const renamedLock = JSON.parse(await readFile(join(app.root, lockPath), "utf8"));
  assert(renamedLock.outputs.some((entry) => entry.path === ".codex/agents/relay-engine.toml"));
  assert(!renamedLock.outputs.some((entry) => entry.path === ".codex/agents/relay-core.toml"));
  app.manifest.agents = app.manifest.agents.filter((agent) => agent.name !== "relay-engine");
  await app.saveManifest();
  assert.equal((await buildBundle({ root: app.root })).removed.length, 3);
  const removedLock = JSON.parse(await readFile(join(app.root, lockPath), "utf8"));
  assert(!removedLock.outputs.some((entry) => entry.path.includes("relay-engine")));
  for (const [path, text] of Object.entries(unrelated))
    assert.equal(await readFile(join(app.root, path), "utf8"), text);
  assert.equal((await checkBundle({ root: app.root })).ok, true);
});

test("изменение исходника обновляет собственные файлы, а ручная правка защищена и от записи, и от удаления", async (t) => {
  const app = await fixture(t);
  await buildBundle({ root: app.root });
  await app.put(`${sourceRoot}/core.md`, "# Новые инструкции Core\n");
  assert.equal((await buildBundle({ root: app.root })).written.length, 4);
  await app.put(".codex/agents/relay-core.toml", "# Важная ручная правка\n");
  let before = await snapshot(app.root);
  await assert.rejects(buildBundle({ root: app.root }), /изменён вручную.*relay-core/);
  assert.deepEqual(await snapshot(app.root), before);
  app.manifest.agents = app.manifest.agents.filter((agent) => agent.name !== "relay-core");
  await app.saveManifest();
  before = await snapshot(app.root);
  await assert.rejects(buildBundle({ root: app.root }), /изменён вручную.*relay-core/);
  assert.deepEqual(await snapshot(app.root), before);
});

test("чужая коллизия, даже побайтно совпадающая, останавливает всю публикацию", async (t) => {
  for (const path of [
    "opencode.json",
    ".claude/settings.json",
    ".codex/agents/relay-qa.toml",
    ".codex/config.toml",
  ]) {
    await t.test(path, async (t) => {
      const app = await fixture(t);
      const { output } = await prepareBundle(app.root);
      await app.put(path, output.get(path));
      const before = await snapshot(app.root);
      assert(
        (await checkBundle({ root: app.root })).issues.some(
          (issue) => issue.kind === "unmanaged" && issue.path === path,
        ),
      );
      await assert.rejects(buildBundle({ root: app.root }), /Чужой файл/);
      assert.deepEqual(await snapshot(app.root), before);
    });
  }
});

test("вход валидируется целиком до записи", async (t) => {
  const agentField =
    (key, value, index = 1) =>
    (app) => {
      app.manifest.agents[index][key] = value;
    };
  const manifestField = (key, value) => (app) => {
    app.manifest[key] = value;
  };
  const cases = [
    ["нет профиля", agentField("prompt", "missing.md"), /Нет исходного файла/],
    ["повтор имени", agentField("name", "relay-orchestrator"), /Повтор имени/],
    ["выход за корень", agentField("prompt", "../outside.md"), /Недопустимый относительный путь/],
    ["абсолютный путь", agentField("prompt", "/tmp/outside.md"), /Недопустимый относительный путь/],
    ["Windows-путь", agentField("prompt", "C:\\outside.md"), /Недопустимый относительный путь/],
    [
      "нормализуемый путь",
      agentField("prompt", "nested/../frontend.md"),
      /Недопустимый относительный путь/,
    ],
    ["не Markdown", agentField("prompt", "manifest.json"), /prompt должен/],
    ["два оркестратора", agentField("kind", "orchestrator"), /ровно один/],
    ["нет оркестратора", agentField("kind", "worker", 0), /ровно один/],
    ["не тот оркестратор", manifestField("orchestrator", "relay-qa"), /не совпадает/],
    ["версия", manifestField("version", 2), /version: 1/],
    ["не массив", manifestField("agents", {}), /должен быть массивом/],
    ["не объект", manifestField("agents", [null]), /ожидается объект/],
    ["вид", agentField("kind", "primary"), /неверный kind/],
    ["readOnly", agentField("readOnly", "true"), /булевым/],
    ["неизвестное поле", agentField("model", "model"), /неизвестные поля/],
    ["пустое описание", agentField("description", "  "), /непустой/],
    ["неверный Unicode", agentField("description", "\ud800"), /корректный текст/],
    ["опасное имя", agentField("name", "../qa"), /Неверное имя/],
  ];
  for (const [name, change, error] of cases) {
    await t.test(name, async (t) => {
      const app = await fixture(t);
      change(app);
      await app.saveManifest();
      const before = await snapshot(app.root);
      await assert.rejects(buildBundle({ root: app.root }), error);
      assert.deepEqual(await snapshot(app.root), before);
    });
  }
});

test("отсутствие manifest/профиля и повреждённый JSON объясняются без создания выходов", async (t) => {
  for (const path of [`${sourceRoot}/manifest.json`, `${sourceRoot}/orchestrator.md`]) {
    await t.test(path, async (t) => {
      const app = await fixture(t);
      await rm(join(app.root, path));
      const before = await snapshot(app.root);
      await assert.rejects(buildBundle({ root: app.root }), /Нет исходного файла/);
      assert.deepEqual(await snapshot(app.root), before);
    });
  }
  const app = await fixture(t);
  await app.put(`${sourceRoot}/manifest.json`, "{");
  await assert.rejects(prepareBundle(app.root), /Некорректный JSON/);
});

test("lock не даёт удалять произвольные пути и отклоняет неоднозначное владение", async (t) => {
  const app = await fixture(t);
  await buildBundle({ root: app.root });
  const lock = JSON.parse(await readFile(join(app.root, lockPath), "utf8"));
  for (const invalid of [
    { ...lock, version: 2 },
    { ...lock, generator: "other" },
    { ...lock, outputs: [...lock.outputs, lock.outputs[0]] },
    { ...lock, outputs: [{ path: "../../AGENTS.md", sha256: "0".repeat(64) }] },
    { ...lock, outputs: [{ path: "AGENTS.md", sha256: "0".repeat(64) }] },
    { ...lock, outputs: [{ path: "opencode.json", sha256: "не хеш" }] },
  ]) {
    await app.put(lockPath, JSON.stringify(invalid));
    const before = await snapshot(app.root);
    await assert.rejects(buildBundle({ root: app.root }));
    assert.deepEqual(await snapshot(app.root), before);
  }
});

test("прежний владелец lock мигрирует только после проверки старых хешей и без присвоения чужих файлов", async (t) => {
  const app = await fixture(t);
  await buildBundle({ root: app.root });
  const modern = JSON.parse(await readFile(join(app.root, lockPath), "utf8"));
  assert.equal(modern.generator, "@relay/dev-agents");
  const legacy = structuredClone(modern);
  legacy.generator = "scripts/agent-bundle";
  const path = ".opencode/agents/relay-core.md";
  const modernContent = await readFile(join(app.root, path), "utf8");
  const oldContent = modernContent.replace("@relay/dev-agents", "scripts/agent-bundle/build.mjs");
  legacy.outputs.find((entry) => entry.path === path).sha256 = createHash("sha256")
    .update(oldContent)
    .digest("hex");
  await app.put(path, oldContent);
  await app.put(lockPath, JSON.stringify(legacy));
  await app.put(".opencode/agents/personal.md", "# Чужой агент\n");
  let before = await snapshot(app.root);
  const report = await checkBundle({ root: app.root });
  assert.equal(report.ok, false);
  assert(report.issues.some((issue) => issue.path === lockPath && issue.kind === "outdated"));
  assert.deepEqual(await snapshot(app.root), before);

  // Даже совпадение ручной правки с новым результатом не заменяет проверку старого sha.
  await app.put(path, modernContent);
  before = await snapshot(app.root);
  await assert.rejects(buildBundle({ root: app.root }), /изменён вручную/);
  assert.deepEqual(await snapshot(app.root), before);
  await app.put(path, oldContent);
  // Файл без записи владения нельзя присвоить при миграции.
  await app.put(
    lockPath,
    JSON.stringify({
      ...legacy,
      outputs: legacy.outputs.filter((entry) => entry.path !== "opencode.json"),
    }),
  );
  before = await snapshot(app.root);
  await assert.rejects(buildBundle({ root: app.root }), /Чужой файл: opencode.json/);
  assert.deepEqual(await snapshot(app.root), before);

  await app.put(lockPath, JSON.stringify(legacy));
  const result = await buildBundle({ root: app.root });
  assert(result.written.includes(path));
  assert(result.written.includes(lockPath));
  assert.equal(await readFile(join(app.root, path), "utf8"), modernContent);
  assert.equal(
    await readFile(join(app.root, ".opencode/agents/personal.md"), "utf8"),
    "# Чужой агент\n",
  );
  assert.equal(
    JSON.parse(await readFile(join(app.root, lockPath), "utf8")).generator,
    "@relay/dev-agents",
  );
  assert.equal((await checkBundle({ root: app.root })).ok, true);
});

test("CLI и aliases сохраняют JSON, относительный root и пути с пробелами при смене cwd", async (t) => {
  const app = await fixture(t);
  const packageRoot = join(repoRoot, "packages/dev-agents");
  const commands = [
    {
      command: process.execPath,
      args: [join(packageRoot, "scripts/build.mjs"), "--root", app.root],
      cwd: packageRoot,
    },
    {
      command: "pnpm",
      args: ["--silent", "run", "agents:build", "--root", relative(repoRoot, app.root)],
      cwd: repoRoot,
    },
    {
      command: "pnpm",
      args: [
        "--silent",
        "--filter",
        "@relay/dev-agents",
        "run",
        "check",
        "--root",
        relative(repoRoot, app.root),
      ],
      cwd: repoRoot,
    },
    {
      command: "pnpm",
      args: ["--silent", "run", "check", "--root", relative(packageRoot, app.root)],
      cwd: packageRoot,
    },
    {
      command: process.execPath,
      args: [join(packageRoot, "scripts/check.mjs"), "--root", "."],
      cwd: app.root,
    },
  ];
  for (const { command, args, cwd } of commands) {
    const result = spawnSync(command, [...args, "--format", "json"], { cwd, encoding: "utf8" });
    assert.equal(
      result.status,
      0,
      `${command} ${args.join(" ")}: ${result.stderr}\n${result.stdout}`,
    );
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).ok, true);
  }
  const invalid = cli("check", app.root, "--unknown", "--format", "json");
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stderr, "");
  assert.equal(JSON.parse(invalid.stdout).ok, false);
});

test("ссылки из источников, выходных каталогов и lock не ведут к чужим данным", async (t) => {
  const outside = await fixture(t);
  for (const path of [`${sourceRoot}/frontend.md`, sourceRoot, ".opencode", lockPath]) {
    await t.test(path, async (t) => {
      const app = await fixture(t);
      await rm(join(app.root, path), { recursive: true, force: true });
      const destination =
        path.endsWith(".md") || path.endsWith(".json")
          ? join(outside.root, sourceRoot, "frontend.md")
          : outside.root;
      await symlink(destination, join(app.root, path));
      const before = await snapshot(outside.root);
      await assert.rejects(buildBundle({ root: app.root }), /Символьная ссылка запрещена/);
      assert.deepEqual(await snapshot(outside.root), before);
    });
  }
});

test("адаптеры сохраняют полный Markdown и описание, наследуют модель и не ограничивают возможности", async (t) => {
  const app = await fixture(t);
  const description =
    "Кавычки: \"двойные\", 'одинарные', \\ и [скобки], # YAML\nВторая строка\tтабуляция\u0085\u2028\u2029🙂";
  app.manifest.agents.forEach((agent) => {
    agent.description = description;
  });
  app.manifest.agents.find((agent) => agent.name === "relay-core").readOnly = false;
  app.manifest.agents.find((agent) => agent.name === "relay-qa").readOnly = true;
  await app.saveManifest();
  await app.put(
    `${sourceRoot}/frontend.md`,
    '# Полный профиль\r\n\r\n```toml\r\nvalue = """\\n \\\\ \'\'\'"""\r\n```\r\n',
  );
  const { output, agents } = await prepareBundle(app.root);
  const opencode = JSON.parse(output.get("opencode.json"));
  assert.equal(opencode.$schema, "https://opencode.ai/config.json");
  assert.equal(opencode.default_agent, "relay-orchestrator");
  assert.equal(opencode.model, undefined);
  assert.equal(opencode.agent, undefined);
  assert.equal(opencode.permission, undefined);
  assert.equal(JSON.parse(output.get(".claude/settings.json")).agent, "relay-orchestrator");
  assert.equal(output.has("CLAUDE.md"), false);
  assert.equal(output.has("AGENTS.md"), false);
  assert.equal(output.has(".codex/agents/relay-orchestrator.toml"), false);
  for (const agent of agents) {
    const primary = agent.kind === "orchestrator";
    const open = readAgentMarkdown(output.get(`.opencode/agents/${agent.name}.md`));
    const claude = readAgentMarkdown(output.get(`.claude/agents/${agent.name}.md`));
    const codex = output.get(primary ? ".codex/config.toml" : `.codex/agents/${agent.name}.toml`);
    assert.equal(open.fields.description, description);
    assert.equal(claude.fields.description, description);
    assert.equal(claude.fields.name, agent.name);
    assert.equal(open.body, agent.body);
    assert.equal(claude.body, agent.body);
    assert.equal(readTomlString(codex, "developer_instructions"), agent.body);
    assert.equal(open.fields.mode, primary ? "primary" : "subagent");
    assert.equal(open.fields.model, undefined);
    assert.equal(claude.fields.model, "inherit");
    assert.doesNotMatch(codex, /^model\s*=/m);
    assert.equal(open.fields.permission, undefined);
    assert.equal(open.fields.tools, undefined);
    assert.equal(claude.fields.tools, undefined);
    assert.equal(claude.fields.disallowedTools, undefined);
    assert.equal(claude.fields.permissionMode, undefined);
    assert.doesNotMatch(codex, /^sandbox_mode\s*=/m);
    if (primary) {
      assert.match(codex, /\[agents\]\nenabled = true/);
    } else {
      assert.equal(readTomlString(codex, "name"), agent.name);
      assert.equal(readTomlString(codex, "description"), description);
      assert.doesNotMatch(codex, /\[agents\]/);
    }
  }
});

test("CLI отдельно предоставляет русскую справку, человеческий итог и JSON без постороннего вывода", async (t) => {
  const app = await fixture(t);
  const help = cli("build", app.root, "--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Корень проекта/);
  let result = cli("check", app.root, "--format", "json");
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).ok, false);
  result = cli("build", app.root, "--format", "json");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).outputs, 29);
  result = cli("check", app.root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Сборка актуальна/);
  await app.put(`${sourceRoot}/manifest.json`, "не JSON");
  result = cli("build", app.root, "--format", "json");
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.match(JSON.parse(result.stdout).error, /Некорректный JSON/);
});
