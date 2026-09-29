import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkGate, gateName, gitCommit, requiredJobs, sha256 } from "../ci.mjs";
import { allPages, githubReader, readEvidenceZip } from "./github-read.mjs";
import { verifyLinearRebase } from "./rebase-proof.mjs";

export const repository = "oim-dev/relay";
export const workflowPath = ".github/workflows/ci.yml";
const prefix = `/repos/${repository}`;
const shaPattern = /^[0-9a-f]{40}$/;
const id = (value) => Number.isSafeInteger(value) && value > 0;

/**
 * Граница доверия: владелец должен доверять этой версии workflow и helpers.
 * Path/ID, хеш ci.yml и API-связи привязывают результат к конкретному коду, но не
 * доказывают безопасность PR, изменившего сам проверяющий код. Независимые review/
 * protection находятся вне guard; он не создаёт собственный корень доверия.
 */
export async function verificationPolicy(root) {
  return {
    workflow_sha256: sha256(await readFile(join(root, workflowPath))),
    package_manager: JSON.parse(await readFile(join(root, "package.json"), "utf8")).packageManager,
    lock_sha256: sha256(await readFile(join(root, "pnpm-lock.yaml"))),
    node_major: 24,
  };
}

export function createVerification({
  event,
  env,
  commit,
  policy,
  needs,
  node = process.versions.node,
}) {
  checkGate(needs);
  assert.equal(env.GITHUB_EVENT_NAME, "pull_request");
  assert(["opened", "synchronize"].includes(event.action), "Событие не является новой ревизией PR");
  assert.equal(event.repository?.full_name, repository);
  assert.equal(env.GITHUB_REPOSITORY, repository);
  const pr = event.pull_request;
  assert(id(pr?.number) && pr.number === event.number && id(event.repository.id));
  assert.equal(pr.base.repo.full_name, repository);
  assert.equal(pr.base.repo.id, event.repository.id);
  assert(id(pr.head?.repo?.id), "Нет head repository PR");
  assert.equal(env.GITHUB_REF, `refs/pull/${pr.number}/merge`);
  assert.equal(env.GITHUB_WORKFLOW_REF, `${repository}/${workflowPath}@${env.GITHUB_REF}`);
  assert.equal(env.GITHUB_WORKFLOW_SHA, commit.sha);
  assert.equal(commit.sha, env.GITHUB_SHA, "Проверялся не synthetic merge SHA события");
  assert.deepEqual(
    commit.parents,
    [pr.base.sha, pr.head.sha],
    "Родители проверяемого synthetic merge отличаются от PR",
  );
  assert.equal(Number(node.split(".")[0]), policy.node_major);
  for (const sha of [commit.sha, commit.tree, ...commit.parents]) assert.match(sha, shaPattern);
  assert(id(Number(env.GITHUB_RUN_ID)) && id(Number(env.GITHUB_RUN_ATTEMPT)));
  return {
    schema: 1,
    repository: { name: repository, id: event.repository.id },
    pull_request: {
      number: pr.number,
      head_sha: pr.head.sha,
      head_repository_id: pr.head.repo.id,
      base_sha: pr.base.sha,
      base_ref: pr.base.ref,
    },
    tested: { sha: commit.sha, tree: commit.tree },
    run: { id: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT) },
    workflow: { path: workflowPath, sha: env.GITHUB_WORKFLOW_SHA, sha256: policy.workflow_sha256 },
    toolchain: {
      node,
      package_manager: policy.package_manager,
      lock_sha256: policy.lock_sha256,
      runner: "ubuntu-24.04",
    },
  };
}

function runAssociations(run) {
  assert(Array.isArray(run.pull_requests), "Неверный список PR в метаданных run");
  for (const entry of run.pull_requests)
    assert(id(entry?.number), "Неверный номер PR в метаданных run");
  return run.pull_requests;
}

function validateRun(run, pr, workflow, repoId) {
  assert(id(run.id) && id(run.run_attempt));
  assert.equal(run.repository?.id, repoId, "Run другого репозитория");
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.head_repository?.id, pr.head.repo.id, "Run другого head repository");
  assert.equal(run.workflow_id, workflow.id, "Run другого workflow");
  assert.equal(run.path, workflowPath, "Другой ожидаемый workflow path");
  assert.equal(run.event, "pull_request");
  assert.equal(run.head_sha, pr.head.sha, "Проверен не final head PR");
  assert.equal(run.status, "completed", "Run ещё не завершён");
  assert.equal(run.conclusion, "success", "Актуальный run не успешен");
  const associations = runAssociations(run);
  // GitHub возвращает [] и для корректного pull_request run. Это отсутствие ассоциаций,
  // а не доказательство чужого PR: обязательная связь устанавливается ниже через witness
  // доверенного workflow и checked M с родителями B/H. Mutable PR.base.sha не используем.
  if (associations.length)
    assert(
      associations.some(
        (entry) =>
          entry.number === pr.number &&
          entry.head?.sha === pr.head.sha &&
          entry.base?.repo?.id === repoId,
      ),
      "Явная API-ассоциация run противоречит нужному PR/head/repository",
    );
}

/** Частичный rerun наследует успешные jobs, но не отменяет более поздние неуспешные выполнения. */
export function effectiveJobs(history, run) {
  const expected = [...Object.values(requiredJobs), gateName].sort();
  const latest = new Map();
  const ids = new Set();
  const executions = new Set();
  for (const job of history) {
    assert(expected.includes(job.name), "В истории run обнаружен неожиданный job");
    assert.equal(job.run_id, run.id, "Job другого run");
    assert(id(job.id) && !ids.has(job.id), "Неоднозначный ID job в истории run");
    ids.add(job.id);
    assert(id(job.run_attempt) && job.run_attempt <= run.run_attempt, "Неверная попытка job");
    const execution = `${job.name}\0${job.run_attempt}`;
    assert(!executions.has(execution), "Неоднозначный job одной попытки");
    executions.add(execution);
    const previous = latest.get(job.name);
    if (!previous || previous.run_attempt < job.run_attempt) latest.set(job.name, job);
  }
  assert.deepEqual([...latest.keys()].sort(), expected, "Неполный набор обязательных jobs run");
  const gate = latest.get(gateName);
  for (const job of latest.values()) {
    assert.equal(job.status, "completed");
    assert.equal(job.conclusion, "success", `Неуспешная обязательная проверка: ${job.name}`);
    assert(
      job.run_attempt <= gate.run_attempt,
      "Gate устарел: после него повторялись обязательные jobs",
    );
  }
  return { jobs: [...latest.values()], gate };
}

function validateArtifact(artifact, run, gate, pr, repoId, now) {
  assert(id(artifact.id));
  assert.equal(artifact.name, "pr-verification");
  assert.equal(artifact.expired, false, "Свидетельство истекло");
  assert(Date.parse(artifact.expires_at) > now, "Свидетельство истекло/неверный срок");
  assert.equal(artifact.workflow_run?.id, run.id, "Артефакт другого run");
  assert.equal(artifact.workflow_run?.repository_id, repoId);
  assert.equal(artifact.workflow_run?.head_repository_id, pr.head.repo.id);
  assert.equal(artifact.workflow_run?.head_sha, pr.head.sha);
  assert.match(artifact.digest ?? "", /^sha256:[0-9a-f]{64}$/, "Нет достоверного digest артефакта");
  const created = Date.parse(artifact.created_at);
  // Artifact API не содержит run_attempt. Попытка берётся из effective gate и JSON
  // свидетельства, а этот интервал связывает конкретный artifact ID с выполнением gate.
  assert(
    created >= Date.parse(gate.started_at) && created <= Date.parse(gate.completed_at),
    "Артефакт не принадлежит допущенному успешному gate",
  );
}

/** Admission без выполнения кода/восстановления outputs из PR. Клиент внедряется для offline-тестов. */
export async function verifyRelease({ client, commit, policy, now = Date.now() }) {
  assert.match(commit.sha, shaPattern);
  assert.match(commit.tree, shaPattern);
  assert(
    [1, 2].includes(commit.parents.length),
    "Допускаются обычный merge или доказанная однородительская история, не эта topology",
  );
  const associated = await allPages(client, `${prefix}/commits/${commit.sha}/pulls`);
  const matches = associated.filter(
    (pr) =>
      pr.merged_at &&
      pr.merge_commit_sha === commit.sha &&
      pr.base?.ref === "main" &&
      pr.base?.repo?.full_name === repository,
  );
  assert.equal(
    matches.length,
    1,
    "Tag SHA должен быть точным результатом одного merged PR в main; direct push не допускается",
  );
  assert(id(matches[0].number));
  const pr = await client.json(`${prefix}/pulls/${matches[0].number}`);
  assert.equal(pr.number, matches[0].number);
  assert(pr.merged === true && pr.state === "closed" && pr.merged_at);
  assert.equal(pr.merge_commit_sha, commit.sha);
  assert.equal(pr.base?.ref, "main");
  assert.equal(pr.base?.repo?.full_name, repository);
  assert(id(pr.base.repo.id) && id(pr.head?.repo?.id));
  assert.match(pr.head.sha, shaPattern);
  if (commit.parents.length === 2)
    assert.equal(commit.parents[1], pr.head.sha, "Merge parent2 не является final head PR");
  const repoId = pr.base.repo.id;
  const workflow = await client.json(`${prefix}/actions/workflows/ci.yml`);
  assert(
    id(workflow.id) && workflow.path === workflowPath && workflow.state === "active",
    "Ожидаемый CI workflow не найден/не активен",
  );
  const runs = await allPages(
    client,
    `${prefix}/actions/workflows/${workflow.id}/runs?event=pull_request&head_sha=${pr.head.sha}`,
    "workflow_runs",
  );
  const candidates = runs.filter((run) => {
    const associations = runAssociations(run);
    // Исключаем только явно связанный с другим PR run. При [] учитываем его как
    // кандидата того же workflow/H: неизвестность нельзя обходить старым success.
    return associations.length === 0 || associations.some((entry) => entry.number === pr.number);
  });
  assert(candidates.length, "Нет run проверки final head PR");
  for (const run of candidates) assert(id(run.id));
  candidates.sort((a, b) => b.id - a.id);
  // Не фильтруем по success и не откатываемся к прежнему зелёному run.
  const run = await client.json(`${prefix}/actions/runs/${candidates[0].id}`);
  assert.equal(run.id, candidates[0].id);
  validateRun(run, pr, workflow, repoId);
  const attemptPath = `${prefix}/actions/runs/${run.id}/attempts/${run.run_attempt}`;
  const attempt = await client.json(attemptPath);
  validateRun(attempt, pr, workflow, repoId);
  assert.equal(attempt.id, run.id);
  assert.equal(attempt.run_attempt, run.run_attempt);
  // filter=latest может не содержать сохранённые успешные jobs предыдущих попыток.
  // Не ищем «последний success»: более поздние failure/cancelled/skipped обязаны блокировать.
  const history = await allPages(
    client,
    `${prefix}/actions/runs/${run.id}/jobs?filter=all`,
    "jobs",
  );
  const { gate } = effectiveJobs(history, run);
  const artifacts = await allPages(
    client,
    `${prefix}/actions/runs/${run.id}/artifacts`,
    "artifacts",
  );
  const found = artifacts.filter((artifact) => artifact.name === "pr-verification");
  assert.equal(found.length, 1, "Нет единственного pr-verification у точного run");
  validateArtifact(found[0], run, gate, pr, repoId, now);
  const artifact = await client.json(`${prefix}/actions/artifacts/${found[0].id}`);
  assert.equal(artifact.id, found[0].id);
  assert.equal(artifact.digest, found[0].digest);
  validateArtifact(artifact, run, gate, pr, repoId, now);
  const zip = await client.archive(`${prefix}/actions/artifacts/${artifact.id}/zip`);
  assert.equal(`sha256:${sha256(zip)}`, artifact.digest, "Digest pr-verification не совпадает");
  const record = readEvidenceZip(zip);
  assert.equal(record.schema, 1);
  assert.deepEqual(record.repository, { name: repository, id: repoId });
  assert.deepEqual(
    record.run,
    { id: run.id, attempt: gate.run_attempt },
    "Свидетельство не соответствует допущенному успешному gate этого run",
  );
  const testedBase = record.pull_request?.base_sha;
  assert.match(testedBase ?? "", shaPattern, "Нет tested base в свидетельстве");
  assert.deepEqual(
    record.pull_request,
    {
      number: pr.number,
      head_sha: pr.head.sha,
      head_repository_id: pr.head.repo.id,
      base_sha: testedBase,
      base_ref: "main",
    },
    "Свидетельство другого final head или целевой ветки PR",
  );
  assert.match(record.tested?.sha ?? "", shaPattern);
  assert.equal(record.tested.tree, commit.tree, "Tree выпуска не проверялось");
  const checked = await client.json(`${prefix}/git/commits/${record.tested.sha}`);
  assert.equal(checked.sha, record.tested.sha);
  assert.equal(checked.tree?.sha, commit.tree, "API tree synthetic merge отличается");
  assert.deepEqual(
    checked.parents?.map((parent) => parent.sha),
    [testedBase, pr.head.sha],
    "API родители synthetic merge отличаются",
  );
  assert.deepEqual(record.workflow, {
    path: workflowPath,
    sha: record.tested.sha,
    sha256: policy.workflow_sha256,
  });
  const source = await client.json(`${prefix}/contents/${workflowPath}?ref=${record.workflow.sha}`);
  assert(
    source.type === "file" && source.encoding === "base64" && typeof source.content === "string",
  );
  assert.equal(
    sha256(Buffer.from(source.content, "base64")),
    policy.workflow_sha256,
    "В проверенном run другой код ci.yml",
  );
  assert.match(record.toolchain?.node ?? "", /^24\.\d+\.\d+$/);
  assert.equal(Number(record.toolchain.node.split(".")[0]), policy.node_major);
  assert.equal(record.toolchain.package_manager, policy.package_manager);
  assert.equal(record.toolchain.lock_sha256, policy.lock_sha256);
  assert.equal(record.toolchain.runner, "ubuntu-24.04");
  let topology;
  if (commit.parents.length === 2) {
    assert.equal(commit.parents[0], testedBase, "Merge выполнен не от точного tested base");
    topology = "merge";
  } else if (commit.parents[0] === testedBase) {
    // Squash и однокоммитный rebase структурно неразличимы; не угадываем метод по сообщению.
    topology = "single-parent";
  } else {
    await verifyLinearRebase({ client, prefix, pr, commit, testedBase });
    topology = "linear-rebase";
  }
  // Закрываем гонку с новым rerun во время загрузки свидетельства.
  const current = await client.json(`${prefix}/actions/runs/${run.id}`);
  validateRun(current, pr, workflow, repoId);
  assert.equal(current.id, run.id);
  assert.equal(current.run_attempt, run.run_attempt, "Во время admission началась другая попытка");
  return {
    pr: pr.number,
    run_id: run.id,
    run_attempt: run.run_attempt,
    verification_attempt: gate.run_attempt,
    artifact_id: artifact.id,
    commit: commit.sha,
    tested: record.tested.sha,
    topology,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, destination, ...extra] = process.argv.slice(2);
  assert(!extra.length);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const commit = gitCommit(root);
  const policy = await verificationPolicy(root);
  if (action === "create") {
    assert(destination);
    const record = createVerification({
      event: JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8")),
      env: process.env,
      commit,
      policy,
      needs: JSON.parse(process.env.CI_NEEDS),
    });
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
    console.log(
      `Свидетельство PR #${record.pull_request.number}, run ${record.run.id}/${record.run.attempt} создано`,
    );
  } else {
    assert(action === "verify" && !destination, "Укажите create <file> или verify");
    const result = await verifyRelease({
      client: githubReader(process.env.GH_TOKEN),
      commit,
      policy,
    });
    console.log(`Допуск выпуска: ${JSON.stringify(result)}`);
  }
}
