import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { buildBundle, prepareBundle, sourceRoot } from "./lib.mjs";
import { fixture } from "./testing.mjs";

const options = {
  skip: process.env.RELAY_AGENT_BUNDLE_CLI_CHECK !== "1",
  timeout: 120000,
};

/** Изолирует CLI от пользовательских настроек, ключей, плагинов и внешних MCP. */
async function environment(t) {
  const app = await fixture(t);
  app.manifest.agents.forEach((agent) => {
    agent.description = `Роль "${agent.name}"\\\nВторая строка\u2028🙂`;
  });
  await app.saveManifest();
  await app.put(
    `${sourceRoot}/orchestrator.md`,
    `${app.prompts.get("relay-orchestrator")}\n\`\`\`toml\nvalue = """\\n"""\n\`\`\`\n`,
  );
  await buildBundle({ root: app.root });
  for (const name of ["home", "config", "data", "cache", "state"]) {
    await mkdir(join(app.root, name));
  }
  const env = {
    PATH: process.env.PATH,
    HOME: join(app.root, "home"),
    XDG_CONFIG_HOME: join(app.root, "config"),
    XDG_DATA_HOME: join(app.root, "data"),
    XDG_CACHE_HOME: join(app.root, "cache"),
    XDG_STATE_HOME: join(app.root, "state"),
    CODEX_HOME: join(app.root, ".codex"),
    CLAUDE_CONFIG_DIR: join(app.root, "home"),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_PURE: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  const run = (command, args, input) => {
    const result = spawnSync(command, args, {
      cwd: app.root,
      env,
      encoding: "utf8",
      timeout: 45000,
      input,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    return result.stdout;
  };
  run("git", ["init", "--quiet"]);
  return { ...app, run };
}

test("OpenCode загружает все полные профили с унаследованной моделью", options, async (t) => {
  const app = await environment(t);
  t.diagnostic(app.run("opencode", ["--version"]).trim());
  const prepared = await prepareBundle(app.root);
  for (const expected of prepared.agents) {
    const actual = JSON.parse(app.run("opencode", ["debug", "agent", expected.name, "--pure"]));
    assert.equal(actual.name, expected.name);
    assert.equal(actual.description, expected.description);
    assert.equal(actual.prompt.trim(), expected.body.trim());
    assert.equal(actual.model, undefined);
    assert.equal(actual.mode, expected.kind === "orchestrator" ? "primary" : "subagent");
  }
});

test(
  "Claude обнаруживает девять файлов через SDK initialize без обращения к модели",
  options,
  async (t) => {
    const app = await environment(t);
    t.diagnostic(app.run("claude", ["--version"]).trim());
    const response = app.run(
      "claude",
      [
        "-p",
        "--setting-sources",
        "project",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
      ],
      JSON.stringify({
        type: "control_request",
        request_id: "init",
        request: { subtype: "initialize" },
      }) + "\n",
    );
    const initialized = response
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find(
        (message) => message.type === "control_response" && message.response.request_id === "init",
      );
    assert.equal(initialized?.response.subtype, "success");
    const agents = initialized.response.response.agents.filter((agent) =>
      agent.name.startsWith("relay-"),
    );
    assert.equal(agents.length, 9);
    for (const expected of app.manifest.agents) {
      const actual = agents.find((agent) => agent.name === expected.name);
      assert.equal(actual?.description, expected.description);
      assert.equal(actual.model, undefined);
    }
  },
);

test(
  "Codex принимает config и самостоятельные TOML, а загрузчик замечает повреждённый профиль",
  options,
  async (t) => {
    const app = await environment(t);
    t.diagnostic(app.run("codex", ["--version"]).trim());
    const initialize =
      [
        {
          id: 0,
          method: "initialize",
          params: { clientInfo: { name: "relay-bundle-test", version: "1" } },
        },
        { method: "initialized" },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n";
    const start = () =>
      app
        .run("codex", ["app-server", "--strict-config"], initialize)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const messages = start();
    assert(messages.some((message) => message.id === 0 && message.result));
    assert.deepEqual(
      messages.filter((message) => message.error || message.method === "configWarning"),
      [],
    );
    const prepared = await prepareBundle(app.root);
    const body = prepared.agents.find((agent) => agent.kind === "orchestrator").body;
    const prompt = JSON.parse(app.run("codex", ["debug", "prompt-input"]));
    assert(prompt.some((message) => message.content?.some((content) => content.text === body)));
    // Код 0 сам по себе недостаточен: проверяем, что CLI действительно сканировал agents/.
    await app.put(".codex/agents/relay-qa.toml", "[невалидный TOML");
    assert(
      start().some(
        (message) =>
          message.method === "configWarning" && message.params.summary.includes("relay-qa.toml"),
      ),
    );
  },
);
