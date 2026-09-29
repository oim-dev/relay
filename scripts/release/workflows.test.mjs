import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { gateName, requiredJobs } from "../ci.mjs";

const root = new URL("../../", import.meta.url);
// Workflows используют только step anchors без merge keys. Раскрываем их перед проверкой jobs.
export function expandStepAnchors(text) {
  const anchors = new Map(
    [...text.matchAll(/^      - &([\w-]+)\n((?:        .*\n|\n)+)/gm)].map(([, name, body]) => [
      name,
      `      -\n${body}`,
    ]),
  );
  return text.replace(/^      - \*([\w-]+)$/gm, (_, name) => {
    assert(anchors.has(name), `Нет step anchor ${name}`);
    return anchors.get(name).trimEnd();
  });
}
function jobsOf(text) {
  const sections = expandStepAnchors(text).split(/^  ([\w-]+):\s*$/m);
  const result = {};
  for (let index = 1; index < sections.length; index += 2)
    result[sections[index]] = sections[index + 1];
  return result;
}
const readWorkflow = (name) => readFile(new URL(`.github/workflows/${name}.yml`, root), "utf8");

test("матрица событий: только opened/synchronize (включая draft), не push/merge/release/reopened/ready", async () => {
  const ci = await readWorkflow("ci");
  const events = ci
    .split(/^on:\n/m)[1]
    .split(/^permissions:/m)[0]
    .trim();
  assert.equal(events, "pull_request:\n    types: [opened, synchronize]");
  const types = events.match(/types: \[([^\]]+)\]/)[1].split(", ");
  for (const [event, action, expected] of [
    ["pull_request", "opened", true],
    ["pull_request", "synchronize", true],
    ["pull_request", "ready_for_review", false],
    ["pull_request", "reopened", false],
    ["pull_request", "closed", false],
    ["push", "dev", false],
    ["push", "main", false],
    ["release", "published", false],
    ["workflow_call", "", false],
  ])
    for (const draft of [false, true])
      assert.equal(
        event === "pull_request" && types.includes(action),
        expected,
        `${event}/${action}, draft=${draft}`,
      );
  assert.doesNotMatch(ci, /pull_request\.draft|paths:|branches:|workflow_call:|workflow_dispatch:/);
  assert.match(
    ci,
    /group: relay-pr-\$\{\{ github.event.pull_request.number \}\}\n  cancel-in-progress: true/,
  );
});

test("PR: явные jobs, один build, immutable exact artifact, прямые проверки, fail-closed final gate", async () => {
  const ci = await readWorkflow("ci");
  const jobs = jobsOf(ci.split(/^jobs:\n/m)[1]);
  assert.deepEqual(Object.keys(jobs), [...Object.keys(requiredJobs), "gate"]);
  for (const [id, name] of Object.entries(requiredJobs)) {
    const job = jobs[id];
    assert(job.includes(`name: ${name}\n`));
    assert.match(job, /ref: \$\{\{ github.sha \}\}/);
    assert.match(job, /persist-credentials: false/);
    assert.match(job, /fetch-depth: 2/);
    assert.match(job, /node-version: "24"/);
    assert.match(job, /pnpm install --frozen-lockfile/);
    assert.match(job, new RegExp(`run: node scripts/ci\\.mjs ${id}\\n`));
    if (!["preflight", "build"].includes(id)) {
      assert.match(job, /needs: build/);
      assert.match(job, /artifact-ids: \$\{\{ needs.build.outputs.artifact_id \}\}/);
      assert.match(job, /ARTIFACT_ID: \$\{\{ needs.build.outputs.artifact_id \}\}/);
      assert(job.indexOf("ci.mjs artifact-id") < job.indexOf("actions/download-artifact@"));
      assert(job.indexOf("ci.mjs restore") < job.indexOf(`ci.mjs ${id}\n`));
      assert.match(job, /digest-mismatch: error/);
      assert.doesNotMatch(job, /ci\.mjs build|ci\.mjs capture/);
    }
  }
  assert.match(jobs.build, /needs: preflight/);
  assert.match(jobs.build, /ci\.mjs capture/);
  assert.match(
    jobs.build,
    /name: pr-build-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}-\$\{\{ github.sha \}\}/,
  );
  assert.match(jobs.build, /include-hidden-files: true/);
  assert.doesNotMatch(jobs.build, /overwrite: true/);
  assert.equal((ci.match(/run: node scripts\/ci.mjs build\n/g) ?? []).length, 1);
  assert.doesNotMatch(ci, /pnpm run check\b|turbo run|release:publish|id-token:|uses: \.\//);
  assert.match(jobs.gate, /if: always\(\)/);
  assert(jobs.gate.includes(`name: ${gateName}\n`));
  assert.deepEqual(
    jobs.gate.match(/needs: \[([^\]]+)\]/)[1].split(", "),
    Object.keys(requiredJobs),
  );
  assert.match(jobs.gate, /CI_NEEDS: \$\{\{ toJSON\(needs\) \}\}/);
  assert(jobs.gate.indexOf("ci.mjs gate") < jobs.gate.indexOf("verified-pr.mjs create"));
  assert(
    jobs.gate.indexOf("verified-pr.mjs create") < jobs.gate.indexOf("actions/upload-artifact@"),
  );
  assert.match(jobs.gate, /name: pr-verification/);
  assert.match(jobs.gate, /if-no-files-found: error/);
});

test("release: admission -> pack -> smoke -> publish без root check/test и повторного build", async () => {
  const release = await readWorkflow("release");
  const jobs = jobsOf(release.split(/^jobs:\n/m)[1]);
  assert.deepEqual(Object.keys(jobs), ["metadata", "pack", "smoke", "publish"]);
  assert.match(release, /types: \[published\]/);
  assert.doesNotMatch(
    release,
    /contents: write|NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.|workflow_dispatch:|\n  push:|\n  pull_request:|uses: \.\/|needs\.ci\./,
  );
  assert.match(
    jobs.metadata,
    /permissions:\n      contents: read\n      actions: read\n      pull-requests: read/,
  );
  assert.match(jobs.metadata, /verified-pr\.mjs verify/);
  assert.match(jobs.metadata, /event\.mjs/);
  assert.match(jobs.metadata, /relay\.mjs check/);
  assert.match(jobs.metadata, /relay\.mjs notes/);
  assert.match(jobs.metadata, /GH_TOKEN: \$\{\{ github.token \}\}/);
  assert.match(jobs.pack, /needs: metadata/);
  assert.match(jobs.pack, /ci\.mjs build/);
  assert.match(jobs.pack, /ci\.mjs pack/);
  assert.match(jobs.pack, /bundle\.mjs create/);
  assert.match(jobs.pack, /name: npm-packages/);
  assert.match(jobs.pack, /artifact_id: \$\{\{ steps.upload.outputs.artifact-id \}\}/);
  assert.match(jobs.smoke, /needs: \[metadata, pack\]/);
  assert.match(jobs.smoke, /bundle\.mjs restore/);
  assert.match(jobs.smoke, /pnpm run package:smoke/);
  assert.match(jobs.publish, /needs: \[metadata, pack, smoke\]/);
  assert.match(jobs.publish, /environment: npm/);
  assert.match(
    jobs.publish,
    /permissions:\n      contents: read\n      actions: read\n      pull-requests: read\n      id-token: write/,
  );
  assert.match(jobs.publish, /group: relay-npm-publish\n      cancel-in-progress: false/);
  assert.match(jobs.publish, /bundle\.mjs verify/);
  assert.match(jobs.publish, /pnpm run release:publish "\$RELEASE_TAG"/);
  for (const name of ["pack", "smoke", "publish"]) {
    assert.match(jobs[name], /ref: \$\{\{ needs.metadata.outputs.commit \}\}/);
    assert.match(jobs[name], /persist-credentials: false/);
    assert.match(jobs[name], /node-version: "24"/);
    assert.match(jobs[name], /npm@11\.16\.0/);
    if (name !== "publish")
      assert.doesNotMatch(jobs[name], /actions: read|pull-requests: read|GH_TOKEN:/);
  }
  for (const name of ["smoke", "publish"]) {
    assert.match(jobs[name], /artifact-ids: \$\{\{ needs.pack.outputs.artifact_id \}\}/);
    assert.match(jobs[name], /ARTIFACT_ID: \$\{\{ needs.pack.outputs.artifact_id \}\}/);
    assert(
      jobs[name].indexOf("ci.mjs artifact-id") < jobs[name].indexOf("actions/download-artifact@"),
    );
    assert.match(jobs[name], /digest-mismatch: error/);
    assert.doesNotMatch(
      jobs[name],
      /pnpm install|ci\.mjs (?:build|pack)\b|bundle\.mjs create|package:check/,
    );
  }
  assert.equal((release.match(/id-token: write/g) ?? []).length, 1);
  assert.equal((release.match(/ci\.mjs build/g) ?? []).length, 1);
  assert.doesNotMatch(
    release,
    /pnpm run (?:check|test|release:test|agents:test|skills:test)|ci\.mjs (?:tooling|cli|server|libraries|mcp|package-smoke)\b/,
  );
  for (const text of [release, await readWorkflow("ci")]) {
    assert.match(text, /^permissions:\n  contents: read$/m);
    for (const [, action] of text.matchAll(/uses: (.+)/g))
      assert.match(action, /^[\w/-]+@[0-9a-f]{40}(?: #.*)?$/);
  }
});

test("retry потребителей использует outputs успешного producer, а не имя из нового run_attempt", async () => {
  const ci = jobsOf((await readWorkflow("ci")).split(/^jobs:\n/m)[1]);
  const release = jobsOf((await readWorkflow("release")).split(/^jobs:\n/m)[1]);
  const consumers = [
    ...Object.keys(requiredJobs)
      .filter((name) => !["preflight", "build"].includes(name))
      .map((name) => [ci[name], "build"]),
    [release.smoke, "pack"],
    [release.publish, "pack"],
  ];
  for (const [job, producer] of consumers) {
    const artifactExpression = job.match(/artifact-ids: (.+)/)[1];
    assert.equal(artifactExpression, `\${{ needs.${producer}.outputs.artifact_id }}`);
    assert(
      !job.includes("${{ github.run_attempt }}"),
      "Нельзя выбирать артефакт по попытке потребителя",
    );
    assert.doesNotMatch(
      job,
      /ci\.mjs (?:build|pack)\n|bundle\.mjs create|uses: actions\/upload-artifact@/,
    );
  }
  // Публикация повторяется как отдельный job: сохранённые metadata/pack/smoke остаются needs,
  // перед записью admission читается заново, но tests/pack/build/smoke не повторяются.
  assert.match(release.publish, /needs: \[metadata, pack, smoke\]/);
  assert.match(release.publish, /artifact-ids: \$\{\{ needs.pack.outputs.artifact_id \}\}/);
  assert.match(release.publish, /bundle\.mjs verify "\$RELAY_RELEASE_BUNDLE"/);
  assert.match(release.publish, /verified-pr\.mjs verify/);
  assert.match(release.publish, /GH_TOKEN: \$\{\{ github.token \}\}/);
  assert(
    release.publish.indexOf("verified-pr.mjs verify") <
      release.publish.indexOf("pnpm run release:publish"),
  );
  assert.doesNotMatch(release.publish, /continue-on-error:|if: always\(\)/);
  assert.doesNotMatch(
    release.publish,
    /ci\.mjs (?:build|pack|tooling|preflight)\b|package:smoke|pnpm run (?:check|test|build)/,
  );
  const localPublisher = await readFile(new URL("scripts/release/relay.mjs", root), "utf8");
  assert.doesNotMatch(localPublisher, /verified-pr|GH_TOKEN|GITHUB_TOKEN/);
  assert.match(localPublisher, /await publishPackages\(root, release.packages\)/);
});
