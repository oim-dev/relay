import { readFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { inspectArchive } from "./bundle.mjs";
import { runNpm } from "./npm.mjs";
import { publishedIntegrity, shouldPublish, taggedVersion, compareVersions } from "./registry.mjs";

export async function publishPackages(
  root,
  packages,
  {
    getIntegrity = publishedIntegrity,
    getTag = taggedVersion,
    executeNpm = runNpm,
    inspect = inspectArchive,
  } = {},
) {
  const plan = [];
  // Проверяем все архивы и существующие версии до первой публикации.
  for (const metadata of packages) {
    const archive = join(root, "apps", metadata.component, ".artifacts/npm", metadata.archiveName);
    const content = await readFile(archive);
    inspect(archive, metadata);
    const current = await getIntegrity(metadata.name, metadata.version);
    const publish = shouldPublish(content, current);
    const channel = await getTag(metadata.name, metadata.distTag);
    assert(
      channel === null || compareVersions(channel, metadata.version) <= 0,
      `${metadata.name}: канал ${metadata.distTag} уже новее; повтор не изменяет dist-tags. Проверьте состояние выпуска вручную.`,
    );
    if (!publish)
      assert.equal(
        channel,
        metadata.version,
        `${metadata.name}: архив совпадает, но канал отличается; dist-tags автоматически не исправляются`,
      );
    plan.push({ metadata, archive, content, publish });
  }
  for (const { metadata, archive, publish } of plan) {
    if (!publish) {
      console.log(`${metadata.name}@${metadata.version}: опубликованный архив совпадает`);
      continue;
    }
    // npm сам выбирает OIDC в CI или локальную авторизацию; её настройки не меняются.
    console.log(
      `${metadata.name}@${metadata.version}: публикация готового архива в ${metadata.distTag}`,
    );
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
  // После неоднозначного сбоя повторяют те же архивы; канал никогда не исправляется отдельной записью.
  for (const { metadata, content } of plan) {
    const current = await getIntegrity(metadata.name, metadata.version);
    assert(
      current !== null,
      `${metadata.name}: версия пока не видна в npm; повторите проверку с теми же архивами`,
    );
    assert.equal(shouldPublish(content, current), false);
    assert.equal(
      await getTag(metadata.name, metadata.distTag),
      metadata.version,
      `${metadata.name}: канал после публикации отличается; проверьте registry, не пересобирайте архивы`,
    );
  }
  console.log(
    "Комплект проверен в npm: integrity всех трёх архивов и ожидаемые dist-tags совпадают",
  );
}
