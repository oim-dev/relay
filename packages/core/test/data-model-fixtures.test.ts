/**
 * A08 (+A03/A04/A09 через исполнитель): каждая замороженная база переносится одной командой
 * Core до текущего профиля, затем читается предметными сервисами и сравнивается с независимым
 * oracle фикстуры (что генератор подал на вход и что вернул старый CLI той версии).
 * Oracle не строится мигратором: ожидания — исходный ввод и ответы старого reader.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { storageMigrationResultSchema } from "@relay/contracts/storage-maintenance";
import { AppError } from "../src/shared/errors.js";
import {
  inspectStorage,
  migrateStorage,
  planStorageMigration,
} from "../src/application/storage/maintenance.js";
import { verifyBackupContent } from "../src/storage/data-model/backup.js";
import { openWorkspace } from "../src/storage/workspace.js";
import { EntityEngine } from "../src/application/entities/service.js";
import { BoardTasksService } from "../src/application/board-tasks/service.js";
import { PlanningService } from "../src/application/planning/service.js";
import { ReleasesService } from "../src/application/releases/service.js";
import {
  FIXTURES,
  frozenProject,
  tempDir,
  treeHashes,
  persistent,
} from "./helpers/migration-bases.js";

type Oracle = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const NAMES = [
  "legacy-c1c353f",
  "legacy-5c7265b",
  "physical1-90d7b26",
  "physical2-plan-v1-43d683b",
  "physical2-plan-v1-equal-rank-43d683b",
  "physical2-v0.6.1-ec4a2cc",
  "physical3-3875aee",
  "physical4-v0.7.0-52c4609",
];
/** Поля ввода, которые сервис возвращает в data под тем же именем и в той же форме. */
const FIELDS = [
  "name",
  "summary",
  "description",
  "body",
  "title",
  "goal",
  "rationale",
  "boundaries",
  "expectedResult",
  "result",
  "version",
  "plannedFor",
  "featureId",
  "applicationId",
  "scenarioId",
  "parentId",
  "planIds",
  "participants",
  "dependencies",
  "related",
  "slug",
  "prefix",
  "pinned",
] as const;

/** Ребро из постоянных наборов отношений (inline и сегменты) по ID. */
async function findEdge(root: string, id: string) {
  const visit = async (directory: string): Promise<Record<string, unknown> | undefined> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = await visit(path);
        if (found) return found;
      } else if (entry.name.endsWith(".json")) {
        const value = JSON.parse(await readFile(path, "utf8"));
        for (const item of value.entries ?? [])
          if (item.edge?.id === id) return item.edge as Record<string, unknown>;
      }
    }
    return undefined;
  };
  return visit(join(root, "relations"));
}

for (const name of NAMES)
  test(`A08: ${name} — перенос одной командой и сверка с независимым oracle`, async (t) => {
    const oracle: Oracle = JSON.parse(await readFile(join(FIXTURES, name, "oracle.json"), "utf8"));
    const { project, root, configPath } = await frozenProject(t, name);
    const before = await treeHashes(project);
    const plan = await planStorageMigration({ configPath });
    assert.equal(plan.applicable, true, JSON.stringify(plan.blockers.slice(0, 5)));
    assert.deepEqual(await treeHashes(project), before, "dry-run не меняет базу (A13)");
    const backupDir = await tempDir(t);
    const result = await migrateStorage(
      { configPath },
      { backupDir, ifPlan: plan.planFingerprint },
    );
    storageMigrationResultSchema.parse(result);
    assert.equal(result.migrated, true);
    assert.deepEqual(result.steps, plan.steps);
    await verifyBackupContent(result.backup!);
    const status = await inspectStorage({ configPath });
    assert.equal(status.status, "current", JSON.stringify(status.blockers.slice(0, 5)));
    const migrated = await treeHashes(root, persistent);
    assert.equal((await migrateStorage({ configPath }, { backupDir })).migrated, false);
    assert.deepEqual(await treeHashes(root, persistent), migrated, "повтор — no-op (A23)");

    const workspace = await openWorkspace(project, configPath);
    const engine = new EntityEngine(workspace);
    const tasks = new BoardTasksService(workspace);
    const plans = new PlanningService(workspace);

    if (oracle.oldReaderOrderAfter) {
      // Равный rank: порядок этапов старого reader после правки.
      const stages = await plans.stages(`work-plan:${oracle.plan.id}`, { limit: 100 });
      assert.deepEqual(
        stages.items.map((stage) => stage.id),
        oracle.oldReaderOrderAfter,
      );
      return;
    }

    const deleted = new Set((oracle.deleted ?? []).map((entry: Oracle) => entry.id));
    for (const [alias, entity] of Object.entries(oracle.entities as Record<string, Oracle>)) {
      if (!entity.id || !entity.kind || entity.kind === "project" || deleted.has(entity.id))
        continue;
      const detail = await engine.get({ ref: `${entity.kind}:${entity.id}` });
      if (entity.key) assert.equal(detail.key, entity.key, `${alias}: ключ`);
      const data = detail.data as Record<string, unknown>;
      for (const field of FIELDS)
        if (field in entity && field in data)
          assert.deepEqual(data[field], entity[field], `${alias}.${field}`);
      if (entity.criteria) {
        const page = await tasks.listCriteria(entity.key, { limit: 100 });
        assert.equal(page.items.length, entity.criteria.length, `${alias}: критерии`);
        for (const [index, criterion] of (entity.criteria as Oracle[]).entries()) {
          const item = page.items[index]!;
          const { criterion: full } = await tasks.getCriterion(entity.key, item.id);
          assert.equal(full.title, criterion.title, `${alias}.criteria[${index}]`);
          assert.equal(full.description, criterion.description, `${alias}.criteria[${index}]`);
        }
      }
      if (entity.comments) {
        const page = await tasks.listComments(entity.key, { limit: 100 });
        const actual = await Promise.all(
          page.items.map(async (item) => {
            const full = await tasks.getComment(entity.key, item.id);
            return [full.title, full.description, full.actor];
          }),
        );
        for (const comment of entity.comments as Oracle[])
          assert.ok(
            actual.some(
              ([title, description, actor]) =>
                title === comment.title &&
                description === comment.description &&
                actor === comment.actor,
            ),
            `${alias}: комментарий «${comment.title}»`,
          );
      }
      if (entity.kind === "work-plan" && Array.isArray(entity.stages)) {
        const stages = await plans.stages(entity.key, { limit: 100 });
        assert.deepEqual(
          stages.items.map((stage) => [stage.id, stage.title, stage.taskIds]),
          entity.stages.map((stage: Oracle) => [stage.id, stage.title, stage.taskIds]),
          `${alias}: этапы`,
        );
      }
      if (entity.kind === "release" && entity.planIds) {
        const release = await new ReleasesService(workspace).get(entity.key);
        assert.deepEqual(release.planIds, entity.planIds, `${alias}: состав релиза`);
      }
    }
    // A11: удалённые записи не оживают, их адреса не выдаются заново. Legacy хранил удаление
    // только резервом ключа: после переноса ключ остаётся в reservedKeys проекта.
    const reserved = new Set<string>();
    for (const file of await readdir(join(root, "entities/projects")))
      for (const key of JSON.parse(await readFile(join(root, "entities/projects", file), "utf8"))
        .reservedKeys ?? [])
        reserved.add(key);
    for (const entry of oracle.deleted ?? [])
      await assert.rejects(engine.resolve({ ref: `${entry.kind}:${entry.id}` }), (error) => {
        assert.ok(error instanceof AppError);
        if (error.code === "ENTITY_DELETED") return true;
        assert.equal(error.code, "ENTITY_NOT_FOUND");
        assert.ok(reserved.has(entry.key), `ключ ${entry.key} зарезервирован`);
        return true;
      });
    // Прежние ключи остаются алиасами той же сущности.
    for (const [id, alias] of Object.entries((oracle.aliases ?? {}) as Record<string, Oracle>))
      for (const previous of alias.previous) {
        const resolved = await engine.resolve({ ref: previous });
        assert.equal(resolved.ref.id, id, `алиас ${previous}`);
      }
    // A12: диагностические рёбра с ID, активностью, концами и точным описанием.
    for (const key of ["diagnosticActive", "diagnosticRevoked"]) {
      const expected = oracle.relations?.[key];
      if (!expected?.id) continue;
      const edge = await findEdge(root, expected.id);
      assert.ok(edge, `${key}: ребро ${expected.id}`);
      assert.equal(edge.type, expected.type);
      assert.equal(edge.active, expected.active);
      assert.deepEqual([(edge.from as Oracle).kind, (edge.from as Oracle).id], expected.from);
      assert.deepEqual([(edge.to as Oracle).kind, (edge.to as Oracle).id], expected.to);
      if (expected.description !== undefined)
        assert.equal((edge.description as string[]).join("\n"), expected.description);
    }
  });
