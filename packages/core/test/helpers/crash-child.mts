/**
 * Дочерний процесс проверок сбоев миграции (A19/A20/A25). Запуск:
 *   node --conditions=tasks-source --import tsx crash-child.mts <режим> <json-аргументы>
 *
 * Режимы:
 * - migrate {configPath, backupDir?, kill?: {stage, path?, nth}} — миграция; в выбранной
 *   probe-точке процесс завершается сигналом SIGKILL (без finally, освобождения замка и flush);
 * - read {project, configPath, oracle} — повторное открытие и чтение предметными сервисами;
 *   печатает JSON с предметным состоянием для сравнения с непрерывным переносом.
 * Результат печатается одной строкой JSON в stdout.
 */
import { join } from "node:path";
import { migrateStorage, inspectStorage } from "../../src/application/storage/maintenance.js";
import { openWorkspace } from "../../src/storage/workspace.js";
import { PlanningService } from "../../src/application/planning/service.js";
import { ReleasesService } from "../../src/application/releases/service.js";
import { BoardTasksService } from "../../src/application/board-tasks/service.js";
import { EntityEngine } from "../../src/application/entities/service.js";
import { ProgressService } from "../../src/application/progress/service.js";
import { AppError } from "../../src/shared/errors.js";
import type { TransactionStage } from "../../src/storage/entity-store/transaction.js";

type Kill = { stage: TransactionStage; path?: string; nth?: number };
const [mode, raw] = process.argv.slice(2);
const args = JSON.parse(raw ?? "{}");

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

try {
  if (mode === "migrate") {
    const kill = args.kill as Kill | undefined;
    let seen = 0;
    const result = await migrateStorage(
      { configPath: args.configPath },
      args.backupDir ? { backupDir: args.backupDir } : {},
      {
        probe: (stage, path) => {
          if (!kill || stage !== kill.stage) return;
          if (kill.path !== undefined && !(path ?? "").startsWith(kill.path)) return;
          if (++seen === (kill.nth ?? 1)) process.kill(process.pid, "SIGKILL");
        },
      },
    );
    print({ ok: true, result });
  } else if (mode === "status") {
    print({ ok: true, status: await inspectStorage({ configPath: args.configPath }) });
  } else if (mode === "read") {
    const { project, configPath, oracle } = args;
    const status = await inspectStorage({ configPath });
    const workspace = await openWorkspace(project, configPath);
    const plans = new PlanningService(workspace);
    const releases = new ReleasesService(workspace);
    const tasks = new BoardTasksService(workspace);
    const engine = new EntityEngine(workspace);
    const out: Record<string, unknown> = { status: status.status };
    for (const alias of ["P1", "P2", "P3"]) {
      const key = oracle.entities[alias].key as string;
      const plan = await plans.get(key);
      const stages = await plans.stages(key, { limit: 100 });
      out[alias] = {
        status: plan.status,
        revision: plan.revision,
        stages: stages.items.map((stage) => [stage.id, stage.title, stage.taskIds]),
        progress: (await new ProgressService(workspace).workPlan({ ref: key })).counts,
      };
    }
    out.R1 = await releases.get(oracle.entities.R1.key);
    const t1 = await tasks.get(oracle.entities.T1.key);
    out.T1 = { revision: t1.revision, description: t1.description };
    out.T1comments = (await tasks.listComments(oracle.entities.T1.key, { limit: 100 })).items.map(
      (comment) => [comment.id, comment.title, comment.description],
    );
    out.D2 = (await engine.get({ ref: oracle.entities.D2.key })).data;
    // Работа после восстановления: CAS-изменение и новый комментарий в этом процессе.
    const updated = await tasks.update(
      oracle.entities.T1.key,
      { title: "После сбоя", ifRevision: t1.revision, requestId: "crash-cas" },
      "tester",
    );
    await tasks.publishComment(oracle.entities.T1.key, {
      title: "После сбоя",
      description: "Комментарий\r\n",
      actor: "tester",
      actorRole: "operator",
      requestId: "crash-comment",
    });
    out.afterWrite = { revision: updated.revision };
    out.root = join(configPath, "..");
    print({ ok: true, state: out });
  } else throw new Error(`Неизвестный режим ${mode}`);
} catch (error) {
  print({
    ok: false,
    code: error instanceof AppError ? error.code : "UNEXPECTED",
    message: error instanceof Error ? error.message : String(error),
    details: error instanceof AppError ? error.details : undefined,
  });
  process.exitCode = 1;
}
