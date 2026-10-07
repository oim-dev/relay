// @ts-nocheck — исторический генератор-документация; тесты и typecheck его не исполняют.
// Вариант 43d683b с равными rank отдельных plan-stage.
// Операции той версии не создают равные rank (create: last+1, move: перенумерация 0..n-1),
// поэтому после генерации реальными командами rank двух этапов правится вручную,
// затем индексы перестраиваются командой `storage reindex` той же версии, а порядок
// подтверждается старым reader (`plan stages`). Скрипт тестами не исполняется.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { TEXT, createRunner, save, join } from "./lib.mjs";

const [bin, db, oraclePath] = process.argv.slice(2);
mkdirSync(db, { recursive: true });
const run = createRunner({ bin, db, transcript: oraclePath.replace(/\.json$/, ".steps.jsonl") });
run(["init"]);
const tasks = [];
for (let index = 0; index < 4; index++) {
  const result = run([
    "task",
    "create",
    "--board",
    "product",
    "--title",
    `Задача ${index}`,
    "--description",
    index === 0 ? TEXT.crlf : "",
  ]);
  tasks.push({
    id: result.task?.id ?? result.id ?? result.ref?.id,
    key: result.task?.key ?? result.key,
  });
}
const plan = run(["plan", "create", "--title", "План с равными rank", "--goal", TEXT.unicode]);
const planKey = plan.key ?? plan.plan?.key;
const planId = plan.ref?.id ?? plan.plan?.id ?? plan.id;
const stages = [];
for (const title of ["Этап X", "Этап Y", "Этап Z"]) {
  const result = run(["plan", "stage", "create", planKey, "--title", title]);
  stages.push({ id: result.stageId, title });
}
run(["plan", "include", planKey, stages[0].id, "--tasks", tasks[0].key]);
run(["plan", "include", planKey, stages[1].id, "--tasks", tasks[1].key, tasks[2].key]);
run(["plan", "include", planKey, stages[2].id, "--tasks", tasks[3].key]);
run(["plan", "start", planKey]);
const before = run(["plan", "stages", planKey]);

// Ручная правка: все три этапа получают rank 5 (ревизия, даты и авторы не меняются).
const edited = [];
for (const stage of stages) {
  const path = join(db, ".relay/entities/plan-stages", `${stage.id}.json`);
  const record = JSON.parse(readFileSync(path, "utf8"));
  edited.push({ id: stage.id, rankBefore: record.data.rank, rankAfter: 5 });
  record.data.rank = 5;
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
}
const reindex = run(["storage", "reindex"]);
const after = run(["plan", "stages", planKey]);
const expectedOrder = [...stages].sort((a, b) => a.id.localeCompare(b.id)).map((stage) => stage.id);
const observed = (after.items ?? after).map((stage) => stage.id);
save(oraclePath, {
  plan: { id: planId, key: planKey, status: "active", goal: TEXT.unicode },
  tasks,
  stages: stages.map((stage, index) => ({
    ...stage,
    taskIds: [[tasks[0].id], [tasks[1].id, tasks[2].id], [tasks[3].id]][index],
  })),
  manualEdit: edited,
  oldReaderOrderBefore: (before.items ?? before).map((stage) => stage.id),
  oldReaderOrderAfter: observed,
  tieBreakRule:
    "rank asc, затем id.localeCompare (packages/core/src/application/planning/model.ts@43d683b)",
  expectedOrderByRule: expectedOrder,
  reindex,
});
if (JSON.stringify(expectedOrder) !== JSON.stringify(observed))
  throw new Error("old reader order mismatch");
console.log("done", observed);
