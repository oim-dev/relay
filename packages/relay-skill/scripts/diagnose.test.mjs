import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { test } from "node:test";
import { diagnose } from "../src/scripts/diagnose.mjs";
import { repoRoot } from "./lib.mjs";

test("скрипт из поставки работает отдельно без node_modules и не меняет проект", async (t) => {
  const root = await fixture(t);
  const script = join(root, "diagnose.mjs");
  await copyFile(join(repoRoot, "skills/relay/scripts/diagnose.mjs"), script);
  const before = await snapshot(root);
  const result = await promisify(execFile)(
    process.execPath,
    [script, "--root", root, "--offline"],
    { env: { PATH: "" }, cwd: root },
  );
  assert.equal(JSON.parse(result.stdout).configuration.state, "missing");
  assert.equal(result.stderr, "");
  assert.deepEqual(await snapshot(root), before);
});

async function fixture(t) {
  const directory = await mkdtemp(join(repoRoot, ".artifacts/diagnose-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function config(root, value = { version: 1, projectId: "expected" }) {
  await mkdir(join(root, ".relay"), { recursive: true });
  await writeFile(join(root, ".relay/config.json"), JSON.stringify(value));
  await writeFile(join(root, ".relay/storage.json"), '{"schemaVersion":4}');
}
async function snapshot(root) {
  const files = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    files[entry.name] = entry.isDirectory() ? await snapshot(path) : await readFile(path, "utf8");
  }
  return files;
}

test("пустой проект: предложение настройки, без установки и записи", async (t) => {
  const root = await fixture(t);
  const before = await snapshot(root);
  const result = await diagnose({ root, offline: true }, { PATH: "" });
  assert.equal(result.configuration.state, "missing");
  assert.equal(result.runtime.npx, false);
  assert(result.next.includes("offer-setup-before-writing"));
  assert.deepEqual(await snapshot(root), before);
});

test("частичная и повреждённая база не приравнивается к отсутствующей", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, ".relay"));
  let result = await diagnose({ root, offline: true }, {});
  assert(result.next.includes("inspect-existing-relay-directory"));
  await writeFile(join(root, ".relay/config.json"), "{invalid}");
  const before = await snapshot(root);
  result = await diagnose({ root }, {});
  assert.equal(result.configuration.state, "invalid");
  assert.equal(result.server.state, "not-checked");
  assert.deepEqual(await snapshot(root), before);
});

test("поиск вверх, workspace приоритет и явный конфиг", async (t) => {
  const root = await fixture(t);
  await config(root);
  await mkdir(join(root, "src"));
  assert.equal(
    (await diagnose({ root: join(root, "src"), offline: true }, {})).configuration.path,
    join(root, ".relay/config.json"),
  );
  await writeFile(join(root, "relay.workspace.json"), JSON.stringify({ version: 1, projects: {} }));
  assert.equal((await diagnose({ root, offline: true }, {})).configuration.mode, "workspace");
  assert.equal(
    (await diagnose({ root, config: ".relay/config.json", offline: true }, {})).configuration.mode,
    "local",
  );
});

test("наличие клиентских файлов не означает загруженный MCP", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "opencode.jsonc"), '{// комментарий\n "mcp": {}}');
  await mkdir(join(root, ".codex"));
  await writeFile(join(root, ".codex/config.toml"), '[mcp_servers.relay]\ncommand="npx"');
  const before = await snapshot(root);
  const result = await diagnose({ root, offline: true }, {});
  assert.equal(result.client.selected, null);
  assert.equal(result.client.files.length, 2);
  assert(result.client.files.every((file) => file.state === "present-needs-client-validation"));
  assert.equal(result.client.session, "agent-must-call-mcp");
  assert.deepEqual(await snapshot(root), before);
});

test("Server: identity matched/mismatch; посторонний HTTP не является Relay", async (t) => {
  const root = await fixture(t);
  await config(root);
  let id = "expected";
  let foreign = false;
  const server = createServer((req, res) => {
    if (foreign) {
      res.end("<html>another service</html>");
      return;
    }
    const data =
      req.url === "/api/v1/health"
        ? { status: "ok" }
        : req.url === "/api/v1/server"
          ? { mode: "local", defaultProject: id, projects: [{ id, available: true }] }
          : { projectId: id };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, data }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  const before = await snapshot(root);
  assert.equal((await diagnose({ root, serverUrl }, {})).server.identity, "matched");
  id = "other";
  assert.equal((await diagnose({ root, serverUrl }, {})).server.identity, "mismatch");
  foreign = true;
  assert.equal((await diagnose({ root, serverUrl }, {})).server.state, "unavailable-or-invalid");
  assert.deepEqual(await snapshot(root), before);
});

test("недоступный Server и URL с секретом не ведут к init или раскрытию секрета", async (t) => {
  const root = await fixture(t);
  await config(root);
  const offline = await diagnose({ root, serverUrl: "http://127.0.0.1:1" }, {});
  assert.equal(offline.server.state, "unavailable-or-invalid");
  assert(!offline.next.includes("offer-setup-before-writing"));
  const result = await diagnose({ root, serverUrl: "http://user:secret@localhost:4700" }, {});
  assert(!JSON.stringify(result).includes("secret"));
});
