import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runNpm } from "./npm.mjs";
import { publishedIntegrity, shouldPublish } from "./registry.mjs";

export async function publishPackages(
  root,
  packages,
  { getIntegrity = publishedIntegrity, executeNpm = runNpm } = {},
) {
  const plan = [];
  // Проверяем все архивы и существующие версии до первой публикации.
  for (const metadata of packages) {
    const archive = join(root, "apps", metadata.component, ".artifacts/npm", metadata.archiveName);
    const content = await readFile(archive);
    const current = await getIntegrity(metadata.name, metadata.version);
    plan.push({ metadata, archive, publish: shouldPublish(content, current) });
  }
  for (const { metadata, archive, publish } of plan) {
    if (!publish) {
      console.log(`${metadata.name}@${metadata.version}: опубликованный архив совпадает`);
      continue;
    }
    // Явный запуск использует готовые архивы и существующую авторизацию npm, не меняя её настройки.
    const result = await executeNpm(
      [
        "publish",
        archive,
        "--ignore-scripts",
        "--access",
        "public",
        "--registry",
        "https://registry.npmjs.org",
        "--tag",
        metadata.distTag,
        ...(process.env.GITHUB_ACTIONS === "true" ? ["--provenance"] : []),
      ],
      root,
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }
}
