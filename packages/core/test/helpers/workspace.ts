import { mkdtemp, realpath, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { initialize, openWorkspace } from "@relay/core/storage/workspace";
import { defaultConfig } from "@relay/core/domain/config";
import type { Workspace } from "@relay/core/storage/workspace";
import { boardTaskRecordSchema } from "@relay/core/domain/board-task";
import type { BoardTaskRecord } from "@relay/core/domain/board-task";
import { publishTaskCommentSchema } from "@relay/contracts/entities/task-comments";
import type { PublishTaskComment } from "@relay/contracts/entities/task-comments";
import { activityHash } from "@relay/core/storage/task-activity";

export async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tasks-core-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await initialize(root, "tasks");
  return {
    root,
    workspace,
  };
}

/** Старый формат создаётся только явными данными теста, без production mutation. */
export async function legacyWorkspace(root: string) {
  const at = "2026-09-26T00:00:00.000Z";
  await mkdir(join(root, ".relay"), { recursive: true });
  await writeFile(join(root, ".relay/config.json"), JSON.stringify({
    ...structuredClone(defaultConfig), projectId: "Legacy01", storageDir: "tasks",
    projectSettings: { version: 1, name: "Legacy", slug: "legacy", revision: 1 },
  }));
  for (const kind of ["product", "infrastructure"] as const) {
    const directory = join(root, ".relay/boards", kind);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "board.json"), JSON.stringify({
      version: 1, id: `board_${kind}`, slug: kind, prefix: kind === "product" ? "PRODUCT" : "INFRA",
      kind, applicationId: null, revision: 1, createdAt: at, createdBy: "relay",
    }));
  }
  return openWorkspace(root);
}

export async function legacyFixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relay-legacy-fixture-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace: await legacyWorkspace(root) };
}

export async function seedLegacyTask(workspace: Workspace, input: Partial<BoardTaskRecord> = {}) {
  const at = "2026-09-26T00:00:00.000Z";
  const task = boardTaskRecordSchema.parse({
    version: 4, id: "LegacyT1", key: "PRODUCT-1", keys: ["PRODUCT-1"], boardId: "board_product",
    title: "Прежняя задача", description: "Текст\r\n", productLinks: [], column: "inbox", rank: 1, revision: 1,
    dependencies: [], related: [], parentId: null, acceptanceCriteria: [], requests: {}, events: [],
    createdAt: at, updatedAt: at, createdBy: "agent", updatedBy: "agent", ...input,
  });
  const path = join(workspace.configPath, "..", "boards/product/tasks");
  await mkdir(path, { recursive: true });
  const requests = Object.fromEntries(Object.entries(task.requests).map(([key, receipt]) => [key, {
    ...receipt,
    result: { ...receipt.result, ...(receipt.result.task ? {
      task: { ...receipt.result.task, description: receipt.result.task.description.split("\n") },
    } : {}) },
  }]));
  await writeFile(join(path, `${task.id}.json`), JSON.stringify({ ...task, requests, description: task.description.split("\n") }));
  return task;
}

export async function seedLegacyComment(workspace: Workspace, task: BoardTaskRecord, input: PublishTaskComment) {
  const command = publishTaskCommentSchema.parse(input);
  const key = activityHash([command.actor, command.requestId]);
  const result = { id: task.id, commentId: "7", revision: 7, action: "comment-publish" as const, requestId: command.requestId };
  const summary = { id: "7", taskId: task.id, sequence: 7, at: "2026-09-26T00:00:00.000Z", actor: command.actor,
    actorRole: command.actorRole, action: "comment-publish", title: command.title, operationId: key, revision: task.revision, legacy: false, fields: [] };
  for (const [path, value] of [
    [`${task.id}/events/7.json`, { ...summary, changes: [], description: command.description.split("\n") }],
    [`${task.id}/summaries/7.json`, summary],
    [`${task.id}/meta.json`, { version: 1, sequence: 11 }],
    [`receipts/${key}.json`, { hash: activityHash(["comment-publish", task.id, command]), result }],
  ] as const) {
    const target = join(workspace.configPath, "..", "task-activity", path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, JSON.stringify(value));
  }
  return result;
}
