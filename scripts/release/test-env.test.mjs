import assert from "node:assert/strict";
import { test } from "node:test";
import { subprocessEnv } from "./test-env.mjs";

for (const colors of [
  { FORCE_COLOR: "3", NO_COLOR: "1" },
  { FORCE_COLOR: "3" },
  { NO_COLOR: "1" },
]) {
  test(`окружение subprocess изолирует ${Object.keys(colors).join(" и ")}`, () => {
    const inherited = Object.freeze({ PATH: "/test/bin", npm_execpath: "/test/pnpm", ...colors });
    assert.deepEqual(subprocessEnv({}, inherited), {
      PATH: "/test/bin",
      npm_execpath: "/test/pnpm",
    });
    assert.deepEqual(subprocessEnv({ NO_COLOR: "1", npm_execpath: "/override" }, inherited), {
      PATH: "/test/bin",
      npm_execpath: "/override",
      NO_COLOR: "1",
    });
    assert.equal(subprocessEnv({ FORCE_COLOR: "2" }, inherited).FORCE_COLOR, "2");
    assert.deepEqual(inherited, { PATH: "/test/bin", npm_execpath: "/test/pnpm", ...colors });
  });
}
