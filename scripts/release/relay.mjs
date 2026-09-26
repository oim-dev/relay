import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishPackages } from "./publish.mjs";
import { readManifests, setWorkspaceVersion, workspaceRelease } from "./workspace.mjs";

const [action, argument, ...extra] = process.argv.slice(2);
assert(
  ["version", "check", "publish", "notes"].includes(action),
  "Укажите version, check, publish или notes",
);
assert.equal(extra.length, 0, "Релиз общий для всех пакетов: укажите только версию или тег");
const root = fileURLToPath(new URL("../../", import.meta.url));
const release =
  action === "version"
    ? await setWorkspaceVersion(root, argument)
    : workspaceRelease(await readManifests(root), argument ?? process.env.RELEASE_TAG);

if (action === "version" || action === "check") {
  console.log(`Relay ${release.version}: ${release.tag}, npm dist-tag ${release.distTag}`);
  for (const metadata of release.packages) console.log(`${metadata.name}@${metadata.version}`);
} else if (action === "notes") {
  const notes = [
    `# Relay ${release.version}`,
    "CLI, Server и MCP входят в согласованный комплект с единой версией.",
  ];
  for (const metadata of release.packages) {
    const changes = await readFile(join(root, "apps", metadata.component, "CHANGELOG.md"), "utf8");
    const section = changes.split(/^## /m).find((text) => text.startsWith(`${release.version}\n`));
    assert(section, `Нет описания ${metadata.name}@${release.version} в CHANGELOG.md`);
    const body = section.slice(release.version.length).trim();
    assert(body, `Пустое описание ${metadata.name}@${release.version}`);
    notes.push(`## ${metadata.name}\n\n${body}`);
  }
  notes.push(
    `## Установка\n\n\`\`\`bash\n${release.packages.map(({ name, version }) => `npx ${name}@${version} --help`).join("\n")}\n\`\`\``,
  );
  console.log(notes.join("\n\n"));
} else {
  await publishPackages(root, release.packages);
}
