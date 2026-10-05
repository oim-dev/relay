import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { subprocessEnv } from "./testing.mjs";

for (const colors of [
  { FORCE_COLOR: "3", NO_COLOR: "1" },
  { FORCE_COLOR: "3" },
  { NO_COLOR: "1" },
]) {
  test(`subprocess не наследует ${Object.keys(colors).join(" и ")}, но сохраняет overrides`, () => {
    const inherited = Object.freeze({ PATH: "/test/bin", INIT_CWD: "/test/root", ...colors });
    for (const overrides of [{}, { FORCE_COLOR: "2" }, { NO_COLOR: "1" }]) {
      const env = subprocessEnv(overrides, inherited);
      assert.deepEqual(env, { PATH: "/test/bin", INIT_CWD: "/test/root", ...overrides });
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          "console.log(JSON.stringify({ FORCE_COLOR: process.env.FORCE_COLOR, NO_COLOR: process.env.NO_COLOR }))",
        ],
        { env, encoding: "utf8" },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), overrides);
    }
    assert.deepEqual(inherited, { PATH: "/test/bin", INIT_CWD: "/test/root", ...colors });
  });
}
