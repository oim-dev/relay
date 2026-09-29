import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflateRawSync } from "node:zlib";
import { test } from "node:test";
import { gateName, requiredJobs, sha256 } from "../ci.mjs";
import { allPages, crc32, githubReader, readEvidenceZip } from "./github-read.mjs";
import { createVerification, effectiveJobs, verifyRelease, workflowPath } from "./verified-pr.mjs";

const head = "a".repeat(40);
const base = "b".repeat(40);
const tree = "c".repeat(40);
const synthetic = "d".repeat(40);
const final = "e".repeat(40);
const other = "f".repeat(40);
const prefix = "/repos/oim-dev/relay";
const needs = () =>
  Object.fromEntries(Object.keys(requiredJobs).map((name) => [name, { result: "success" }]));

function zipOf(value, { method = 8, descriptor = true, name = "verification.json" } = {}) {
  const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  const packed = method === 0 ? bytes : deflateRawSync(bytes);
  const filename = Buffer.from(name);
  const crc = crc32(bytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(descriptor ? 8 : 0, 6);
  local.writeUInt16LE(method, 8);
  if (!descriptor) {
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
  }
  local.writeUInt16LE(filename.length, 26);
  const trailer = Buffer.alloc(descriptor ? 16 : 0);
  if (descriptor) {
    trailer.writeUInt32LE(0x08074b50);
    trailer.writeUInt32LE(crc, 4);
    trailer.writeUInt32LE(packed.length, 8);
    trailer.writeUInt32LE(bytes.length, 12);
  }
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(descriptor ? 8 : 0, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + packed.length + trailer.length, 16);
  return Buffer.concat([local, filename, packed, trailer, central, filename, end]);
}

function fixture(topology = "merge") {
  const source = "name: PR\non:\n  pull_request:\n    types: [opened, synchronize]\n";
  const repo = { id: 10, full_name: "oim-dev/relay" };
  const pr = {
    number: 17,
    state: "closed",
    merged: true,
    merged_at: "2026-09-20T12:00:00Z",
    merge_commit_sha: final,
    // main уже ушёл вперёд: admission не должен требовать base.sha == S или текущий main == S.
    base: { ref: "main", sha: other, repo },
    head: { sha: head, repo: { id: 20, full_name: "contributor/relay" } },
  };
  const policy = {
    workflow_sha256: sha256(source),
    package_manager: "pnpm@11.18.0",
    lock_sha256: "1".repeat(64),
    node_major: 24,
  };
  const event = {
    action: "synchronize",
    number: 17,
    repository: repo,
    pull_request: { ...pr, base: { ...pr.base, sha: base } },
  };
  const env = {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REPOSITORY: repo.full_name,
    GITHUB_REF: "refs/pull/17/merge",
    GITHUB_SHA: synthetic,
    GITHUB_WORKFLOW_REF: `oim-dev/relay/${workflowPath}@refs/pull/17/merge`,
    GITHUB_WORKFLOW_SHA: synthetic,
    GITHUB_RUN_ID: "100",
    GITHUB_RUN_ATTEMPT: "2",
  };
  const checked = { sha: synthetic, tree, parents: [base, head] };
  const record = createVerification({
    event,
    env,
    commit: checked,
    policy,
    needs: needs(),
    node: "24.18.1",
  });
  const commit = { sha: final, tree, parents: topology === "merge" ? [base, head] : [base] };
  const run = {
    id: 100,
    run_attempt: 2,
    repository: repo,
    head_repository: pr.head.repo,
    head_sha: head,
    workflow_id: 50,
    path: workflowPath,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    // Подтверждённая форма GitHub API: корректный PR run может не иметь ассоциаций в массиве.
    pull_requests: [],
    run_started_at: "2026-09-20T10:00:00Z",
    updated_at: "2026-09-20T11:00:00Z",
  };
  const artifact = {
    id: 200,
    name: "pr-verification",
    expired: false,
    created_at: "2026-09-20T10:59:00Z",
    expires_at: "2026-12-19T10:59:00Z",
    workflow_run: {
      id: 100,
      repository_id: repo.id,
      head_repository_id: pr.head.repo.id,
      head_sha: head,
    },
  };
  const jobs = [...Object.values(requiredJobs), gateName].map((name, index) => ({
    id: 1000 + index,
    name,
    run_id: 100,
    run_attempt: 2,
    status: "completed",
    conclusion: "success",
    started_at: name === gateName ? "2026-09-20T10:50:00Z" : "2026-09-20T10:00:00Z",
    completed_at: name === gateName ? "2026-09-20T11:00:00Z" : "2026-09-20T10:49:00Z",
  }));
  const paths = {
    prs: `${prefix}/commits/${final}/pulls?per_page=100&page=1`,
    pr: `${prefix}/pulls/17`,
    workflow: `${prefix}/actions/workflows/ci.yml`,
    runs: `${prefix}/actions/workflows/50/runs?event=pull_request&head_sha=${head}&per_page=100&page=1`,
    run: `${prefix}/actions/runs/100`,
    attempt: `${prefix}/actions/runs/100/attempts/2`,
    jobs: `${prefix}/actions/runs/100/jobs?filter=all&per_page=100&page=1`,
    artifacts: `${prefix}/actions/runs/100/artifacts?per_page=100&page=1`,
    artifact: `${prefix}/actions/artifacts/200`,
    checked: `${prefix}/git/commits/${synthetic}`,
    source: `${prefix}/contents/${workflowPath}?ref=${synthetic}`,
  };
  const responses = new Map([
    [paths.prs, [pr]],
    [paths.pr, pr],
    [paths.workflow, { id: 50, path: workflowPath, state: "active" }],
    [paths.runs, { total_count: 1, workflow_runs: [run] }],
    [paths.run, run],
    [paths.attempt, structuredClone(run)],
    [paths.jobs, { total_count: jobs.length, jobs }],
    [paths.artifacts, { total_count: 1, artifacts: [artifact] }],
    [paths.artifact, artifact],
    [
      paths.checked,
      { sha: synthetic, tree: { sha: tree }, parents: [{ sha: base }, { sha: head }] },
    ],
    [
      paths.source,
      { type: "file", encoding: "base64", content: Buffer.from(source).toString("base64") },
    ],
  ]);
  const requests = [];
  let zip;
  const client = {
    async json(path) {
      requests.push(path);
      assert(responses.has(path), `Непредусмотренный API-запрос: ${path}`);
      const response = responses.get(path);
      return structuredClone(typeof response === "function" ? response() : response);
    },
    async archive(path) {
      requests.push(path);
      assert.equal(path, `${prefix}/actions/artifacts/200/zip`);
      return zip;
    },
  };
  const refresh = (bytes = zipOf(record)) => {
    zip = bytes;
    artifact.digest = `sha256:${sha256(zip)}`;
  };
  refresh();
  return {
    event,
    env,
    checked,
    policy,
    record,
    commit,
    run,
    pr,
    artifact,
    jobs,
    paths,
    responses,
    requests,
    refresh,
    client,
    verify: () =>
      verifyRelease({ client, commit, policy, now: Date.parse("2026-09-28T00:00:00Z") }),
  };
}

test("create: только полностью успешный gate и реальные родители synthetic merge; без timestamp", () => {
  const f = fixture();
  const input = {
    event: f.event,
    env: f.env,
    commit: f.checked,
    policy: f.policy,
    needs: needs(),
    node: "24.18.1",
  };
  assert.deepEqual(createVerification(input), f.record);
  for (const [key, value] of [
    ["GITHUB_SHA", other],
    ["GITHUB_EVENT_NAME", "push"],
    ["GITHUB_WORKFLOW_REF", "foreign"],
    ["GITHUB_WORKFLOW_SHA", other],
    ["GITHUB_RUN_ATTEMPT", "0"],
  ])
    assert.throws(() => createVerification({ ...input, env: { ...f.env, [key]: value } }));
  assert.throws(() => createVerification({ ...input, event: { ...f.event, action: "reopened" } }));
  assert.throws(() =>
    createVerification({ ...input, commit: { ...f.checked, parents: [other, head] } }),
  );
  assert.throws(() =>
    createVerification({ ...input, needs: { ...needs(), cli: { result: "skipped" } } }),
  );
  assert.throws(() => createVerification({ ...input, node: "22.18.0" }));
});

for (const topology of ["merge", "squash"])
  test(`admission: ${topology}, synthetic SHA != tag SHA, main уже ушёл вперёд`, async () => {
    const f = fixture(topology);
    assert.deepEqual(await f.verify(), {
      pr: 17,
      run_id: 100,
      run_attempt: 2,
      verification_attempt: 2,
      artifact_id: 200,
      commit: final,
      tested: synthetic,
      topology: topology === "merge" ? "merge" : "single-parent",
    });
    assert(f.requests.includes(`${prefix}/actions/artifacts/200/zip`));
    assert(!f.requests.some((path) => path.includes("/branches/main")));
  });

test("пустой run.pull_requests связывается evidence и checked M, не mutable PR.base.sha", async () => {
  const f = fixture();
  assert.deepEqual(f.run.pull_requests, []);
  assert.notEqual(f.pr.base.sha, f.record.pull_request.base_sha);
  assert.equal(f.run.head_sha, f.pr.head.sha);
  assert.notEqual(f.run.head_sha, f.record.tested.sha);
  assert.equal((await f.verify()).pr, 17);
  f.record.pull_request.number = 18;
  f.refresh();
  await assert.rejects(f.verify, /Свидетельство другого final head или целевой ветки PR/);
});

test("заполненные PR-ассоциации используются как дополнительная проверка, но не источник tested B", async () => {
  const f = fixture();
  const associations = [{ number: f.pr.number, head: f.pr.head, base: f.pr.base }];
  f.run.pull_requests = associations;
  f.responses.get(f.paths.attempt).pull_requests = structuredClone(associations);
  assert.notEqual(associations[0].base.sha, base);
  assert.equal((await f.verify()).pr, 17);
  f.responses.get(f.paths.attempt).pull_requests[0].head.sha = other;
  await assert.rejects(f.verify, /Явная API-ассоциация/);
});

test("новый run без PR-ассоциаций не позволяет откатиться к старому success того же workflow/H", async (t) => {
  for (const state of ["failure", "cancelled", "in_progress"])
    await t.test(state, async () => {
      const f = fixture();
      const newer = {
        ...f.run,
        id: 101,
        pull_requests: [],
        status: state === "in_progress" ? state : "completed",
        conclusion: state === "in_progress" ? null : state,
      };
      f.responses.set(f.paths.runs, { total_count: 2, workflow_runs: [f.run, newer] });
      f.responses.set(`${prefix}/actions/runs/101`, newer);
      await assert.rejects(f.verify, /Актуальный run не успешен|Run ещё не завершён/);
      assert(!f.requests.includes(f.paths.artifact));
    });
  await t.test("явно другой PR с тем же H не является новой попыткой нужного PR", async () => {
    const f = fixture();
    const foreign = { ...f.run, id: 101, conclusion: "failure", pull_requests: [{ number: 99 }] };
    f.responses.set(f.paths.runs, { total_count: 2, workflow_runs: [f.run, foreign] });
    assert.equal((await f.verify()).run_id, 100);
    assert(!f.requests.includes(`${prefix}/actions/runs/101`));
  });
  await t.test(
    "повреждённая ассоциация нового run не позволяет считать его явно чужим",
    async () => {
      const f = fixture();
      const newer = { ...f.run, id: 101, conclusion: "failure", pull_requests: [{ number: "17" }] };
      f.responses.set(f.paths.runs, { total_count: 2, workflow_runs: [f.run, newer] });
      await assert.rejects(f.verify, /Неверный номер PR/);
    },
  );
});

function useHistory(f, history) {
  f.responses.set(f.paths.jobs, { total_count: history.length, jobs: history });
  return history;
}

function advanceAttempt(f, number, conclusion = "success") {
  Object.assign(f.run, {
    run_attempt: number,
    conclusion,
    run_started_at: "2026-09-21T10:00:00Z",
    updated_at: "2026-09-21T11:00:00Z",
  });
  f.responses.set(`${prefix}/actions/runs/100/attempts/${number}`, structuredClone(f.run));
}

function partialRetry(topology = "merge") {
  const f = fixture(topology);
  const rerun = [requiredJobs.cli, gateName];
  // Первая попытка: build и остальные наборы успешны, CLI и gate упали.
  // Вторая: GitHub повторил только CLI и зависимый gate, сохранив предыдущий build.
  const previous = f.jobs.map((job) => ({
    ...job,
    id: job.id + 1000,
    run_attempt: 1,
    conclusion: rerun.includes(job.name) ? "failure" : "success",
    started_at: "2026-09-19T10:00:00Z",
    completed_at: "2026-09-19T11:00:00Z",
  }));
  const history = useHistory(f, [
    ...f.jobs.filter((job) => rerun.includes(job.name)),
    ...previous.reverse(),
  ]);
  return { ...f, history };
}

for (const topology of ["merge", "squash"])
  test(`Re-run failed jobs: ${topology}, прежний успешный build + новые CLI/gate допускаются`, async () => {
    const f = partialRetry(topology);
    const state = effectiveJobs(f.history, f.run);
    assert.equal(state.jobs.find((job) => job.name === requiredJobs.build).run_attempt, 1);
    assert.equal(state.jobs.find((job) => job.name === requiredJobs.cli).run_attempt, 2);
    assert.equal(state.gate.run_attempt, 2);
    assert.deepEqual(await f.verify(), {
      pr: 17,
      run_id: 100,
      run_attempt: 2,
      verification_attempt: 2,
      artifact_id: 200,
      commit: final,
      tested: synthetic,
      topology: topology === "merge" ? "merge" : "single-parent",
    });
    assert(f.requests.includes(f.paths.jobs));
    assert(!f.requests.some((path) => /\/attempts\/\d+\/jobs/.test(path)));
  });

test("retry только gate после ошибки загрузки свидетельства не требует повторения проверок", async () => {
  const f = fixture();
  const oldGate = f.jobs.find((job) => job.name === gateName);
  oldGate.conclusion = "failure";
  advanceAttempt(f, 3);
  const freshGate = {
    ...oldGate,
    id: 3000,
    run_attempt: 3,
    conclusion: "success",
    started_at: "2026-09-21T10:50:00Z",
    completed_at: "2026-09-21T11:00:00Z",
  };
  useHistory(f, [...f.jobs, freshGate]);
  f.record.run.attempt = 3;
  f.artifact.created_at = "2026-09-21T10:59:00Z";
  f.refresh();
  const result = await f.verify();
  assert.equal(result.run_attempt, 3);
  assert.equal(result.verification_attempt, 3);
  assert.equal(result.artifact_id, 200);
});

test("номер попытки run сам по себе не обесценивает свидетельство неизменного успешного состояния", async () => {
  const f = partialRetry();
  advanceAttempt(f, 3);
  // Фикстура модели API: нет новых выполнений обязательных jobs, старый gate всё ещё актуален.
  // Важны последнее состояние jobs и происхождение witness, а не равенство всех run_attempt.
  const result = await f.verify();
  assert.equal(result.run_attempt, 3);
  assert.equal(result.verification_attempt, 2);
  assert.equal(result.artifact_id, 200);
});

const objectId = (text) => createHash("sha1").update(text).digest("hex");
const blob = (text, mode = "100644", type = "blob") => ({ sha: objectId(text), mode, type });

function rebaseFixture({ baseExtra = {}, changes, targetChanges } = {}) {
  const f = fixture("squash");
  const originalBase = objectId("original-base");
  const originalFirst = objectId("original-first");
  const rewrittenFirst = objectId("rewritten-first");
  const common = {
    "README.md": blob("Общее содержание"),
    "src/one.ts": blob("one v0"),
    "src/two.ts": blob("two v0"),
  };
  changes ??= [
    { "src/one.ts": blob("one v1") },
    { "src/two.ts": blob("two v1") },
    { "src/three.ts": blob("Третье изменение") },
  ];
  targetChanges ??= changes;
  assert.equal(targetChanges.length, changes.length);
  const originalIds = changes.map((_, index) =>
    index === changes.length - 1
      ? head
      : index === 0
        ? originalFirst
        : objectId(`original-${index}`),
  );
  const rewrittenIds = changes.map((_, index) =>
    index === changes.length - 1
      ? final
      : index === 0
        ? rewrittenFirst
        : objectId(`rewritten-${index}`),
  );
  function tree(files) {
    const entries = new Map();
    const directories = new Map();
    for (const [path, entry] of Object.entries(files)) {
      const slash = path.indexOf("/");
      if (slash === -1) entries.set(path, { path, ...entry });
      else {
        const directory = path.slice(0, slash);
        if (!directories.has(directory)) directories.set(directory, {});
        directories.get(directory)[path.slice(slash + 1)] = entry;
      }
    }
    for (const [path, children] of directories) {
      assert(!entries.has(path));
      entries.set(path, { path, type: "tree", mode: "040000", sha: tree(children) });
    }
    const nodes = [...entries.keys()].sort().map((name) => entries.get(name));
    const sha = objectId(JSON.stringify(nodes));
    f.responses.set(`${prefix}/git/trees/${sha}`, { sha, truncated: false, tree: nodes });
    return sha;
  }
  function putCommit(sha, files, parents, message, authorNumber = 0) {
    const record = {
      sha,
      tree: { sha: tree(files) },
      parents: parents.map((sha) => ({ sha })),
      message,
      author: {
        name: `Автор ${authorNumber}`,
        email: `author${authorNumber}@example.test`,
        date: new Date(Date.UTC(2026, 8, 18, 10, 0, authorNumber)).toISOString(),
      },
      committer: {
        name: sha === head || sha === originalFirst ? "Исходный committer" : "GitHub rebase",
      },
    };
    f.responses.set(`${prefix}/git/commits/${sha}`, record);
    return record;
  }
  const apply = (files, change) => {
    const result = { ...files };
    for (const [path, entry] of Object.entries(change)) {
      if (entry === null) delete result[path];
      else result[path] = entry;
    }
    return result;
  };
  const testedFiles = { ...common, ...baseExtra };
  const sourceSnapshots = [];
  const targetSnapshots = [];
  putCommit(originalBase, common, [], "До ветвления");
  putCommit(base, testedFiles, [originalBase], "Проверенная база main");
  let result;
  for (let index = 0; index < changes.length; index++) {
    sourceSnapshots.push(apply(sourceSnapshots.at(-1) ?? common, changes[index]));
    targetSnapshots.push(apply(targetSnapshots.at(-1) ?? testedFiles, targetChanges[index]));
    putCommit(
      originalIds[index],
      sourceSnapshots[index],
      [originalIds[index - 1] ?? originalBase],
      `Изменение ${index + 1}`,
      index + 1,
    );
    result = putCommit(
      rewrittenIds[index],
      targetSnapshots[index],
      [rewrittenIds[index - 1] ?? base],
      `Изменение ${index + 1}`,
      index + 1,
    );
  }
  f.commit.parents = [rewrittenIds.at(-2)];
  f.commit.tree = result.tree.sha;
  f.record.tested.tree = result.tree.sha;
  f.responses.get(f.paths.checked).tree.sha = result.tree.sha;
  f.pr.commits = changes.length;
  const prCommits = `${prefix}/pulls/17/commits?per_page=100&page=1`;
  // Порядок списка не является доказательством: helper восстанавливает цепочку по parents.
  const listed = originalIds.toReversed().map((sha) => ({ sha }));
  for (let page = 1; page <= Math.ceil(listed.length / 100); page++)
    f.responses.set(
      `${prefix}/pulls/17/commits?per_page=100&page=${page}`,
      listed.slice((page - 1) * 100, page * 100),
    );
  f.refresh();
  return {
    ...f,
    originalBase,
    originalFirst,
    rewrittenFirst,
    originalIds,
    rewrittenIds,
    sourceSnapshots,
    targetSnapshots,
    testedFiles,
    tree,
    putCommit,
    prCommits,
    git: (sha) => f.responses.get(`${prefix}/git/commits/${sha}`),
  };
}

test("linear rebase: API-связь PR->S, полные пары коммитов и точная база, main не обязан оставаться на S", async () => {
  for (const baseExtra of [
    {},
    { "src/independent.ts": blob("Независимое изменение main до проверки PR") },
  ]) {
    const f = rebaseFixture({ baseExtra });
    const result = await f.verify();
    assert(f.pr.commits >= 3);
    assert.equal(result.topology, "linear-rebase");
    assert.equal(result.commit, final);
    assert.equal(result.tested, synthetic);
    assert(f.requests.includes(f.prCommits));
    const treeRequests = f.requests.filter((path) => path.includes("/git/trees/"));
    assert.equal(
      new Set(treeRequests).size,
      treeRequests.length,
      "Повторно читаются одни и те же Merkle-узлы",
    );
    assert(
      !f.requests.some((path) => path.includes("/git/blobs/") || path.includes("/branches/main")),
    );
  }
});

test("linear rebase: точные изменения учитывают binary, mode, symlink, gitlink и замену file/directory", async () => {
  const f = rebaseFixture({
    baseExtra: { "src/independent.ts": blob("Фоновый файл") },
    changes: [
      {
        "src/one.ts": blob("one v0", "100755"),
        "binary.bin": blob("\0binary\xff"),
        link: blob("src/one.ts", "120000"),
        vendor: blob("gitlink commit", "160000", "commit"),
      },
      { "src/two.ts": null, "src/two.ts/index.ts": blob("Теперь каталог"), link: null },
      { "src/three.ts": blob("Третье изменение") },
    ],
  });
  assert.equal((await f.verify()).topology, "linear-rebase");
});

test("linear rebase: частичный retry не теряет успешные jobs прежних попыток", async () => {
  const f = rebaseFixture();
  for (const job of f.jobs)
    if (![requiredJobs.cli, gateName].includes(job.name)) job.run_attempt = 1;
  assert.equal((await f.verify()).topology, "linear-rebase");
});

test("rebase не доказывается произвольным ancestor, финальным tree или сообщением коммита", async (t) => {
  const cases = {
    "stale base даже при идентичном tree нового main": (f) => {
      const newerBase = objectId("main advanced after checks");
      f.putCommit(newerBase, f.testedFiles, [base], "Пустой коммит main после QA");
      f.git(f.rewrittenFirst).parents = [{ sha: newerBase }];
    },
    "вставленный коммит между tested base и переписанными PR-коммитами": (f) => {
      const extra = objectId("extra commit");
      f.putCommit(
        extra,
        { ...f.targetSnapshots.at(-2), "alien.txt": blob("Чужой файл") },
        [f.rewrittenIds.at(-2)],
        "Постороннее изменение",
      );
      f.git(final).parents = [{ sha: extra }];
      f.commit.parents = [extra];
    },
    "чужой пустой коммит внутри цепочки не разрешён совпадением tree": (f) => {
      const extra = objectId("empty extra commit");
      f.putCommit(extra, f.targetSnapshots.at(-2), [f.rewrittenIds.at(-2)], "Пустой чужой коммит");
      f.git(final).parents = [{ sha: extra }];
      f.commit.parents = [extra];
    },
    "постороннее изменение промежуточного tree, отменённое к финальному S": (f) => {
      f.git(f.rewrittenFirst).tree.sha = f.tree({
        ...f.targetSnapshots[0],
        "injected.txt": blob("Нет в исходном PR-коммите"),
      });
    },
    "неполный список PR-коммитов": (f) => {
      f.responses.get(f.prCommits).pop();
    },
    "усечённый лимитом API список": (f) => {
      f.pr.commits = 251;
    },
    "повторяющийся PR-коммит": (f) => {
      f.responses.get(f.prCommits)[1] = { sha: head };
    },
    "посторонний коммит вместо цепочки final head": (f) => {
      f.responses.get(f.prCommits)[1] = { sha: other };
    },
    "нелинейная исходная история": (f) => {
      f.git(head).parents.push({ sha: base });
    },
    "нелинейная результирующая история": (f) => {
      f.git(f.rewrittenFirst).parents.push({ sha: f.originalBase });
    },
    "другой автор": (f) => {
      f.git(f.rewrittenFirst).author.email = "other@example.test";
    },
    "сообщение с обещанием rebase не является доказательством": (f) => {
      f.git(f.rewrittenFirst).message = "Rebase PR #17: всё проверено";
    },
    "другие parents tag SHA в API": (f) => {
      f.commit.parents = [other];
    },
    "усечённое tree": (f) => {
      f.responses.get(`${prefix}/git/trees/${f.git(f.rewrittenFirst).tree.sha}`).truncated = true;
    },
    "API вернул другое дерево": (f) => {
      f.responses.get(`${prefix}/git/trees/${f.git(f.rewrittenFirst).tree.sha}`).sha = other;
    },
    "final tree не совпадает с checked tree": (f) => {
      f.commit.tree = other;
    },
    "нет API-связи merged PR -> S": (f) => {
      f.responses.set(f.paths.prs, []);
    },
  };
  for (const [name, mutate] of Object.entries(cases))
    await t.test(name, async () => {
      const f = rebaseFixture({
        baseExtra: {
          "src/independent.ts": blob(
            "Другая база исходной ветки допустима только для точного переноса",
          ),
        },
      });
      mutate(f);
      await assert.rejects(f.verify);
    });
});

test("rebase с изменением blobs при переносе патча требует отдельного replay-доказательства", async () => {
  const f = rebaseFixture({
    baseExtra: { "src/one.ts": blob("one v0 + изменение main") },
    targetChanges: [
      { "src/one.ts": blob("one v1 + изменение main") },
      { "src/two.ts": blob("two v1") },
      { "src/three.ts": blob("Третье изменение") },
    ],
  });
  await assert.rejects(f.verify, /перенос с изменением blobs требует отдельного доказательства/);
});

test("linear rebase: полная пагинация 101 PR-коммита, неполная страница блокирует admission", async () => {
  const changes = Array.from({ length: 101 }, (_, index) => ({
    [`src/added-${index}.ts`]: blob(`Изменение ${index}`),
  }));
  const complete = rebaseFixture({ changes });
  assert.equal((await complete.verify()).topology, "linear-rebase");
  const page2 = `${prefix}/pulls/17/commits?per_page=100&page=2`;
  assert(complete.requests.includes(page2));
  const incomplete = rebaseFixture({ changes });
  incomplete.responses.set(page2, []);
  await assert.rejects(incomplete.verify, /неполный список PR-коммитов/);
  assert(incomplete.requests.includes(page2));
});

test("publisher-only retry перечитывает допуск: прежний metadata success не скрывает позднюю неуспешную попытку PR", async () => {
  for (const state of ["failure", "cancelled", "in_progress"]) {
    const f = partialRetry();
    await f.verify(); // Допуск первого metadata.
    const originalArtifact = { id: f.artifact.id, digest: f.artifact.digest };
    advanceAttempt(f, 3, state === "in_progress" ? null : state);
    if (state === "in_progress") f.run.status = state;
    let writes = 0;
    const beforeWrite = async () => {
      await f.verify();
      writes++;
    };
    await assert.rejects(beforeWrite);
    assert.equal(writes, 0);
    assert.deepEqual({ id: f.artifact.id, digest: f.artifact.digest }, originalArtifact);
  }
});

test("retry не принимает устаревшие успехи и witness", async (t) => {
  for (const conclusion of ["failure", "cancelled", "timed_out"])
    await t.test(`поздний ${conclusion} run при сохранённом success/witness`, async () => {
      const f = partialRetry();
      advanceAttempt(f, 3, conclusion);
      await assert.rejects(f.verify, /Актуальный run не успешен/);
      assert(!f.requests.some((path) => path.endsWith("/zip")));
    });
  for (const conclusion of ["failure", "cancelled", "skipped"])
    await t.test(
      `новейший ${conclusion} job не заменяется прежним success даже при зелёном summary`,
      async () => {
        const f = partialRetry();
        advanceAttempt(f, 3);
        const newer = {
          ...f.history.find((job) => job.name === requiredJobs.cli && job.run_attempt === 2),
          id: 3000,
          run_attempt: 3,
          conclusion,
        };
        useHistory(f, [newer, ...f.history]);
        await assert.rejects(f.verify, /Неуспешная обязательная проверка/);
      },
    );
  await t.test(
    "новая успешная проверка после старого gate требует актуального gate, не полного suite",
    async () => {
      const f = partialRetry();
      advanceAttempt(f, 3);
      const newer = {
        ...f.history.find((job) => job.name === requiredJobs.cli && job.run_attempt === 2),
        id: 3000,
        run_attempt: 3,
      };
      useHistory(f, [newer, ...f.history]);
      await assert.rejects(f.verify, /Gate устарел/);
    },
  );
  await t.test(
    "новый gate не допускает JSON прежней попытки даже с новым artifact digest",
    async () => {
      const f = partialRetry();
      advanceAttempt(f, 3);
      const newer = {
        ...f.history.find((job) => job.name === gateName && job.run_attempt === 2),
        id: 3000,
        run_attempt: 3,
        started_at: "2026-09-21T10:50:00Z",
        completed_at: "2026-09-21T11:00:00Z",
      };
      useHistory(f, [...f.history, newer]);
      f.artifact.created_at = "2026-09-21T10:59:00Z";
      f.refresh();
      await assert.rejects(f.verify, /Свидетельство не соответствует/);
    },
  );
  await t.test("время создания artifact не может принадлежать старому gate", async () => {
    const f = partialRetry();
    f.artifact.created_at = "2026-09-19T10:59:00Z";
    await assert.rejects(f.verify, /Артефакт не принадлежит/);
  });
  await t.test("нет сохранённого успешного build в истории", async () => {
    const f = partialRetry();
    useHistory(
      f,
      f.history.filter((job) => job.name !== requiredJobs.build),
    );
    await assert.rejects(f.verify, /Неполный набор/);
  });
  await t.test("job другого run нельзя унаследовать", async () => {
    const f = partialRetry();
    f.history.find((job) => job.name === requiredJobs.build).run_id = 99;
    await assert.rejects(f.verify, /Job другого run/);
  });
  await t.test("неизвестный номер попытки не выводится из success", async () => {
    const f = partialRetry();
    delete f.history[0].run_attempt;
    await assert.rejects(f.verify, /Неверная попытка job/);
  });
  await t.test("двусмысленные выполнения одного job в одной попытке", async () => {
    const f = partialRetry();
    useHistory(f, [...f.history, { ...f.history[0], id: 9000 }]);
    await assert.rejects(f.verify, /Неоднозначный job/);
  });
});

test("admission: отрицательные provenance, final head/base/tree, schema/toolchain и topology", async (t) => {
  const cases = {
    "stale base": (f) => {
      f.record.pull_request.base_sha = other;
    },
    "stale head": (f) => {
      f.record.pull_request.head_sha = other;
    },
    "stale tree": (f) => {
      f.record.tested.tree = other;
    },
    "API synthetic base": (f) => {
      f.responses.get(f.paths.checked).parents[0].sha = other;
    },
    "API synthetic head": (f) => {
      f.responses.get(f.paths.checked).parents[1].sha = other;
    },
    "API synthetic tree": (f) => {
      f.responses.get(f.paths.checked).tree.sha = other;
    },
    "API synthetic SHA": (f) => {
      f.responses.get(f.paths.checked).sha = other;
    },
    "direct push": (f) => {
      f.responses.set(f.paths.prs, []);
    },
    "не точный merge result": (f) => {
      f.pr.merge_commit_sha = other;
    },
    "PR ещё открыт": (f) => {
      f.pr.merged = false;
    },
    "не main": (f) => {
      f.pr.base.ref = "dev";
    },
    octopus: (f) => {
      f.commit.parents.push(other);
    },
    "неподтверждённая цепочка без полного состава PR": (f) => {
      f.commit.parents = [other];
    },
    "merge parent2": (f) => {
      f.commit.parents[1] = other;
    },
    "двусмысленный PR": (f) => {
      f.responses.get(f.paths.prs).push({ ...f.pr, number: 18 });
    },
    "нет run": (f) => {
      f.responses.set(f.paths.runs, { total_count: 0, workflow_runs: [] });
    },
    "failed run": (f) => {
      f.run.conclusion = "failure";
    },
    "cancelled run": (f) => {
      f.run.conclusion = "cancelled";
    },
    "running run": (f) => {
      f.run.status = "in_progress";
    },
    "foreign run repository": (f) => {
      f.run.repository = { id: 999, full_name: "foreign/repo" };
    },
    "foreign head repository": (f) => {
      f.run.head_repository = { id: 999 };
    },
    "wrong run head": (f) => {
      f.run.head_sha = other;
    },
    "wrong run PR": (f) => {
      f.run.pull_requests = [{ number: 99 }];
    },
    "wrong run event": (f) => {
      f.run.event = "push";
    },
    "wrong workflow ID": (f) => {
      f.run.workflow_id = 999;
    },
    "wrong workflow path": (f) => {
      f.run.path = ".github/workflows/other.yml";
    },
    "disabled workflow": (f) => {
      f.responses.get(f.paths.workflow).state = "disabled_manually";
    },
    "wrong workflow content": (f) => {
      f.responses.get(f.paths.source).content = Buffer.from("другой workflow").toString("base64");
    },
    "wrong workflow encoding": (f) => {
      f.responses.get(f.paths.source).encoding = "utf8";
    },
    "wrong evidence workflow": (f) => {
      f.record.workflow.path = "other.yml";
    },
    "wrong workflow SHA": (f) => {
      f.record.workflow.sha = other;
    },
    "missing artifact": (f) => {
      f.responses.set(f.paths.artifacts, { total_count: 0, artifacts: [] });
    },
    "duplicate artifact": (f) => {
      f.responses.set(f.paths.artifacts, {
        total_count: 2,
        artifacts: [f.artifact, { ...f.artifact, id: 201 }],
      });
    },
    "foreign artifact run": (f) => {
      f.artifact.workflow_run.id = 99;
    },
    "foreign artifact repository": (f) => {
      f.artifact.workflow_run.repository_id = 99;
    },
    "foreign artifact head repository": (f) => {
      f.artifact.workflow_run.head_repository_id = 99;
    },
    "foreign artifact head": (f) => {
      f.artifact.workflow_run.head_sha = other;
    },
    "expired artifact flag": (f) => {
      f.artifact.expired = true;
    },
    "expired artifact date": (f) => {
      f.artifact.expires_at = "2026-09-21T00:00:00Z";
    },
    "wrong artifact date": (f) => {
      f.artifact.expires_at = "invalid";
    },
    "previous attempt artifact": (f) => {
      f.artifact.created_at = "2026-09-19T00:00:00Z";
    },
    "wrong record run": (f) => {
      f.record.run.id = 99;
    },
    "wrong record attempt": (f) => {
      f.record.run.attempt = 1;
    },
    "wrong API attempt": (f) => {
      f.responses.get(f.paths.attempt).run_attempt = 1;
    },
    "failed attempt": (f) => {
      f.responses.get(f.paths.attempt).conclusion = "failure";
    },
    "skipped job": (f) => {
      f.jobs[0].conclusion = "skipped";
    },
    "cancelled job": (f) => {
      f.jobs[0].conclusion = "cancelled";
    },
    "missing job": (f) => {
      f.jobs.pop();
      f.responses.get(f.paths.jobs).total_count--;
    },
    "foreign job": (f) => {
      f.jobs[0].run_id = 99;
    },
    "unknown schema": (f) => {
      f.record.schema = 2;
    },
    "foreign record": (f) => {
      f.record.repository.name = "foreign/repo";
    },
    "wrong node": (f) => {
      f.record.toolchain.node = "22.18.0";
    },
    "wrong package manager": (f) => {
      f.record.toolchain.package_manager = "pnpm@9.0.0";
    },
    "wrong lock": (f) => {
      f.record.toolchain.lock_sha256 = "2".repeat(64);
    },
    "wrong runner": (f) => {
      f.record.toolchain.runner = "self-hosted";
    },
  };
  for (const [name, mutate] of Object.entries(cases))
    await t.test(name, async () => {
      const f = fixture();
      mutate(f);
      f.refresh();
      await assert.rejects(f.verify);
    });
});

test("не берётся старый зелёный run, exact artifact ID/digest проверяются, гонка rerun закрыта", async (t) => {
  await t.test("новейший failed вместо прежнего success", async () => {
    const f = fixture();
    const newer = { ...f.run, id: 101, conclusion: "failure" };
    f.responses.set(f.paths.runs, { total_count: 2, workflow_runs: [f.run, newer] });
    f.responses.set(`${prefix}/actions/runs/101`, newer);
    await assert.rejects(f.verify, /не успешен/);
  });
  await t.test("digest изменён", async () => {
    const f = fixture();
    f.artifact.digest = `sha256:${"0".repeat(64)}`;
    await assert.rejects(f.verify, /Digest/);
  });
  await t.test("нет digest", async () => {
    const f = fixture();
    delete f.artifact.digest;
    await assert.rejects(f.verify, /digest/);
  });
  await t.test("exact metadata другого ID", async () => {
    const f = fixture();
    f.responses.set(f.paths.artifact, { ...f.artifact, id: 201 });
    await assert.rejects(f.verify);
  });
  await t.test("попытка изменилась во время чтения", async () => {
    const f = fixture();
    let reads = 0;
    f.responses.set(f.paths.run, () => (++reads === 1 ? f.run : { ...f.run, run_attempt: 3 }));
    await assert.rejects(f.verify, /другая попытка/);
  });
  for (const data of ["не ZIP", zipOf("не JSON"), zipOf({}, { name: "../verification.json" })])
    await t.test("плохой ZIP/JSON", async () => {
      const f = fixture();
      f.refresh(Buffer.isBuffer(data) ? data : Buffer.from(data));
      await assert.rejects(f.verify);
    });
});

test("ZIP: store/deflate и descriptor; порча, пути, CRC, шифрование, zip bomb fail closed", () => {
  for (const method of [0, 8])
    for (const descriptor of [false, true])
      assert.deepEqual(readEvidenceZip(zipOf({ schema: 1 }, { method, descriptor })), {
        schema: 1,
      });
  const zip = zipOf({ schema: 1 });
  const central = zip.readUInt32LE(zip.length - 6);
  const corrupted = [
    zip.subarray(0, -1),
    Buffer.from("bad"),
    zipOf({}, { name: "/verification.json" }),
    zipOf({}, { name: "dir/verification.json" }),
    zipOf("x".repeat(40000)),
  ];
  for (const [offset, value, width] of [
    [central + 8, 1, 2],
    [central + 16, 0, 4],
    [central + 38, 0xa0000000, 4],
    [zip.length - 12, 2, 2],
    [central + 42, 1, 4],
    [central + 24, 10, 4],
  ]) {
    const copy = Buffer.from(zip);
    if (width === 2) copy.writeUInt16LE(value, offset);
    else copy.writeUInt32LE(value, offset);
    corrupted.push(copy);
  }
  for (const invalid of corrupted) assert.throws(() => readEvidenceZip(invalid));
});

test("ZIP совместим с независимым системным архиватором, без распаковки на диск", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-verification-zip-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const record = fixture().record;
  await writeFile(join(directory, "verification.json"), JSON.stringify(record, null, 2));
  await promisify(execFile)("zip", ["-q", "evidence.zip", "verification.json"], { cwd: directory });
  assert.deepEqual(readEvidenceZip(await readFile(join(directory, "evidence.zip"))), record);
});

test("HTTP/JSON: никакой сети в тестах, ошибки fail closed, токен только API, без retry/утечки", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    let calls = 0;
    const client = githubReader("test-secret", async () => {
      calls++;
      return new Response("error", { status });
    });
    await assert.rejects(() => client.json(`${prefix}/pulls/17`), /HTTP\/JSON/);
    assert.equal(calls, 1);
  }
  const invalid = githubReader("test-secret", async () => new Response("not json"));
  await assert.rejects(() => invalid.json(`${prefix}/pulls/17`), /HTTP\/JSON/);
  const badUtf8 = githubReader(
    "test-secret",
    async () =>
      new Response(
        Buffer.concat([Buffer.from('{"value":"'), Buffer.from([255]), Buffer.from('"}')]),
      ),
  );
  await assert.rejects(() => badUtf8.json(`${prefix}/pulls/17`), /HTTP\/JSON/);
  const failure = githubReader("test-secret", async () => {
    throw new Error("test-secret private-url");
  });
  await assert.rejects(
    () => failure.archive(`${prefix}/actions/artifacts/200/zip`),
    (error) => !/test-secret|private-url/.test(error.message),
  );
  let calls = 0;
  const client = githubReader("test-secret", async (url, options) => {
    calls++;
    if (calls === 1) {
      assert(url.startsWith("https://api.github.com/"));
      assert.equal(options.headers.Authorization, "Bearer test-secret");
      assert.equal(options.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://artifact.example.test/signed" },
      });
    }
    assert.equal(url, "https://artifact.example.test/signed");
    assert(!options.headers);
    assert.equal(options.redirect, "error");
    return new Response("zip bytes");
  });
  assert.equal(
    (await client.archive(`${prefix}/actions/artifacts/200/zip`)).toString(),
    "zip bytes",
  );
  assert.equal(calls, 2);
  const insecure = githubReader(
    "test-secret",
    async () => new Response(null, { status: 302, headers: { location: "http://unsafe.test/" } }),
  );
  await assert.rejects(() => insecure.archive(`${prefix}/actions/artifacts/200/zip`));
  const oversized = githubReader(
    "test-secret",
    async () => new Response(Buffer.alloc(1024 * 1024 + 1)),
  );
  await assert.rejects(() => oversized.archive(`${prefix}/actions/artifacts/200/zip`));
});

test("API pagination дочитывается, неполный/неверный ответ не означает отсутствие проверок", async () => {
  let calls = 0;
  const client = {
    json: async (path) => {
      calls++;
      assert(path.endsWith(`per_page=100&page=${calls}`));
      return { total_count: 101, jobs: calls === 1 ? Array(100).fill({}) : [{}] };
    },
  };
  assert.equal((await allPages(client, `${prefix}/jobs`, "jobs")).length, 101);
  assert.equal(calls, 2);
  for (const response of [{}, { total_count: 1, jobs: [] }, { jobs: "invalid" }])
    await assert.rejects(() => allPages({ json: async () => response }, `${prefix}/jobs`, "jobs"));
});
