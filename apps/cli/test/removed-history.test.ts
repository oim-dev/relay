import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { invoke, invokeRaw } from "./helpers/cli.js";

test("Общая история отсутствует в справке и разборе команд без конфигурации", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-no-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const group of ["entities", "graph", "task"]) {
    const help = await invokeRaw(root, [group, "--help"]);
    assert.equal(help.code, 0, help.stdout + help.stderr);
    assert.equal(help.stderr, "");
    assert.doesNotMatch(help.stdout, /\bhistory\b/);
    if (group === "task") assert.match(help.stdout, /\bcomment\b/);
  }
  for (const args of [
    ["entities", "history", "PRODUCT-1"],
    ["graph", "history"],
    ["task", "history", "list", "PRODUCT-1"],
    ["task", "history", "get", "PRODUCT-1", "1"],
  ]) {
    const result = await invoke(root, args);
    assert.notEqual(result.code, 0);
    assert.equal(result.stderr, "");
    assert.ok(!result.body.ok);
    assert.match(result.body.error.message, /history/);
  }
  const comments = await invokeRaw(root, ["task", "comment", "--help"]);
  assert.equal(comments.code, 0);
  assert.equal(comments.stderr, "");
  for (const action of ["list", "get", "publish"])
    assert.match(comments.stdout, new RegExp(`\\b${action}\\b`));
});
