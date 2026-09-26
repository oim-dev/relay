import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifests, workspaceRelease } from "./workspace.mjs";

export function validateEvent(event, release, head, tagCommit) {
  assert.equal(event.action, "published", "Публикация разрешена только событием release.published");
  assert.equal(event.repository?.full_name, "oim-dev/relay");
  assert.equal(event.release?.draft, false);
  assert.equal(event.release?.tag_name, release.tag);
  assert.equal(
    event.release?.prerelease,
    release.distTag === "next",
    "Флаг prerelease не соответствует SemVer",
  );
  assert.equal(head, tagCommit, "Checkout не совпадает с коммитом тега");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const release = workspaceRelease(await readManifests(root), process.env.RELEASE_TAG);
  const git = (ref) =>
    execFileSync("git", ["rev-parse", "--verify", ref], { cwd: root, encoding: "utf8" }).trim();
  validateEvent(event, release, git("HEAD"), git(`refs/tags/${release.tag}^{commit}`));
  console.log(`Событие и коммит ${release.tag} проверены`);
}
