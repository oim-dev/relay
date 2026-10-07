// @ts-nocheck — исторический генератор-документация; тесты и typecheck его не исполняют.
// Генерация исторической базы Relay единого формата реальными операциями CLI/Core той версии.
// Использование: node generate-unified.mjs <relay-bin> <db-dir> <out-oracle.json> <worktree> <profile>
// profile: "f1" (без планов), "f2-stages" (план v1 + отдельные plan-stage + релиз v1),
//          "nested" (вложенные этапы, планы/релизы v2).
// Скрипт — документация происхождения; тесты фикстур его не исполняют.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { TEXT, longComment, createRunner, save, join } from "./lib.mjs";

const [bin, db, oraclePath, worktree, profile] = process.argv.slice(2);
const planning = !["f1", "legacy", "legacy-early"].includes(profile);
const separateStages = profile === "f2-stages";
// Ранний legacy (c1c353f): ещё нет критериев, комментариев, подзадач и удаления сущностей.
const early = profile === "legacy-early";
const legacy = profile === "legacy" || early;
mkdirSync(db, { recursive: true });
const run = createRunner({ bin, db, transcript: oraclePath.replace(/\.json$/, ".steps.jsonl") });
const oracle = { profile, entities: {}, relations: {}, deleted: [], aliases: {}, notes: [] };
const remember = (name, value) =>
  (oracle.entities[name] = { ...(oracle.entities[name] ?? {}), ...value });
const del = (kind, ref, actor = "fixture-author") => {
  const result = spawnSync(
    "node",
    ["--conditions=tasks-source", "--import", "tsx", "fixture-delete.mts", db, kind, ref, actor],
    { cwd: join(worktree, "apps/cli"), encoding: "utf8" },
  );
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    process.exit(1);
  }
  return JSON.parse(result.stdout.trim().split("\n").at(-1)).data;
};

run(["init"]);
const project = run(["entities", "get", "PROJECT"]);
remember("project", { kind: "project", id: project.ref?.id ?? project.id });
const rev = (ref) => String(run(["entities", "get", ref]).revision);
// Изменение с прочитанной ревизией (обязательный --if-revision старых команд).
const upd = (ref, args, options) =>
  run(["entities", "update", ref, "--if-revision", rev(ref), ...args], options);

// Разделы документов проекта.
const sections = [
  ...(project.data.documentSections ?? []),
  { id: "specs", name: "Технические задания" },
  { id: "rules", name: "Правила «команды» 🚦" },
];
if (!early) {
  upd("PROJECT", ["--document-sections", JSON.stringify(sections)]);
  remember("project", { documentSections: sections });
}

// Паспорт продукта.
run([
  "entities",
  "create",
  "product",
  "--name",
  "Relay фикстура «Миграции»",
  "--summary",
  "Краткое\nмногострочное описание",
  "--description",
  TEXT.crlf,
]);
remember("passport", {
  kind: "product",
  id: "passport",
  key: "PRODUCT",
  name: "Relay фикстура «Миграции»",
  summary: "Краткое\nмногострочное описание",
  description: TEXT.crlf,
});

// Фичи и сценарии.
const feature = (name, description, summary = "") => {
  const result = run([
    "entities",
    "create",
    "feature",
    "--name",
    name,
    "--summary",
    summary,
    "--description",
    description,
  ]);
  return { id: result.ref.id, key: result.key };
};
const F1 = feature("Фича CRLF", TEXT.crlf, "Сводка фичи 1");
remember("F1", {
  kind: "feature",
  ...F1,
  name: "Фича CRLF",
  summary: "Сводка фичи 1",
  description: TEXT.crlf,
});
const F2 = feature("Фича Unicode 🚀", TEXT.unicode);
remember("F2", {
  kind: "feature",
  ...F2,
  name: "Фича Unicode 🚀",
  summary: "",
  description: TEXT.unicode,
});
const F3 = feature("Фича для удаления", TEXT.trailing);
remember("F3", { kind: "feature", ...F3, name: "Фича для удаления" });

const scenario = (name, featureRef, description) => {
  const result = run([
    "entities",
    "create",
    "scenario",
    "--name",
    name,
    "--feature",
    featureRef,
    "--description",
    description,
  ]);
  return { id: result.ref.id, key: result.key };
};
const S1 = scenario("Сценарий 1", F1.key, TEXT.markdown);
remember("S1", {
  kind: "scenario",
  ...S1,
  featureId: F1.id,
  name: "Сценарий 1",
  description: TEXT.markdown,
});
const S2 = scenario("Сценарий 2 (mixed EOL)", F1.key, TEXT.mixed);
remember("S2", {
  kind: "scenario",
  ...S2,
  featureId: F1.id,
  name: "Сценарий 2 (mixed EOL)",
  description: TEXT.mixed,
});
const S3 = scenario("Сценарий фичи 2", F2.key, TEXT.unicode);
remember("S3", {
  kind: "scenario",
  ...S3,
  featureId: F2.id,
  name: "Сценарий фичи 2",
  description: TEXT.unicode,
});

// Переименование: прежний ключ становится алиасом.
const renamedF2 = run(["entities", "rename", F2.key, "FEATURE-UX", "--if-revision", rev(F2.key)]);
oracle.aliases[F2.id] = { previous: [F2.key], key: "FEATURE-UX" };
remember("F2", { key: "FEATURE-UX", aliases: [F2.key] });
F2.key = "FEATURE-UX";
void renamedF2;

// Приложения (создают доски и технический состав).
const app = (name, slug, prefix, type, description) => {
  const result = run([
    "entities",
    "create",
    "application",
    "--name",
    name,
    "--slug",
    slug,
    "--prefix",
    prefix,
    "--type",
    type,
    "--description",
    description,
    "--summary",
    `Сводка ${slug}`,
  ]);
  return { id: result.ref.id, key: result.key, slug, prefix };
};
const A1 = app("Веб-клиент", "web", "WEB", "frontend", TEXT.markdown);
remember("A1", {
  kind: "application",
  ...A1,
  type: "frontend",
  name: "Веб-клиент",
  description: TEXT.markdown,
});
const A2 = app("API-сервер", "api", "API", "backend", TEXT.crlf);
remember("A2", {
  kind: "application",
  ...A2,
  type: "backend",
  name: "API-сервер",
  description: TEXT.crlf,
});

// Реализации: FI (фича) и SI (сценарий), активная и неактивная.
const impl = (application, target, title, description, status) => {
  const result = run([
    "entities",
    "create",
    "implementation",
    "--application",
    application,
    "--target",
    target,
    "--title",
    title,
    "--description",
    description,
    "--status",
    status,
  ]);
  return { id: result.ref.id, key: result.key };
};
const FI1 = impl(A1.key, F1.key, "Вклад веба в фичу", TEXT.crlf, "partial");
remember("FI1", {
  kind: "implementation",
  ...FI1,
  applicationId: A1.id,
  featureId: F1.id,
  scenarioId: null,
  status: "partial",
  description: TEXT.crlf,
});
const SI1 = impl(A1.key, S1.key, "Вклад веба в сценарий", TEXT.unicode, "done");
remember("SI1", {
  kind: "implementation",
  ...SI1,
  applicationId: A1.id,
  featureId: F1.id,
  scenarioId: S1.id,
  status: "done",
  description: TEXT.unicode,
});
const FI2 = impl(A2.key, F2.key, "Вклад API (неактивный)", TEXT.trailing, "none");
remember("FI2", {
  kind: "implementation",
  ...FI2,
  applicationId: A2.id,
  featureId: F2.id,
  scenarioId: null,
  status: "none",
});
// Неактивное участие: замена всего состава приложения API пустым набором (операция той версии).
let deactivated = null;
for (let revision = 1; revision <= 3 && !deactivated?.id; revision++) {
  const version = run(["product", "overview"]).version;
  deactivated = run(
    [
      "product",
      "scope",
      "replace",
      A2.key,
      "--json",
      "[]",
      "--if-revision",
      String(revision),
      "--if-version",
      version,
    ],
    { allowFail: true },
  );
}
if (!deactivated?.id) throw new Error("scope replace failed");
remember("FI2", { active: false });
remember("A2", { scope: { id: deactivated.id, implementations: [] } });

// Задачи.
const taskCreate = (args) => {
  const result = run(["task", "create", ...args]);
  const task = result.task ?? result;
  return { id: task.id ?? result.ref?.id, key: task.key ?? result.key, raw: result };
};
const criteria = [
  { title: "Критерий 1", summary: "Сводка\nкритерия", description: TEXT.crlf },
  { title: "Критерий 2 🚀", summary: "", description: TEXT.unicode },
];
const T1 = taskCreate([
  "--board",
  "web",
  "--title",
  "Задача с критериями «T1»",
  "--description",
  TEXT.crlf,
  ...(early ? [] : ["--criteria", JSON.stringify(criteria)]),
  "--implementation",
  FI1.id,
  SI1.id,
]);
const T2 = taskCreate([
  "--board",
  "web",
  "--title",
  "Зависимость T2",
  "--description",
  TEXT.mixed,
  "--column",
  "ready",
]);
const T3 = taskCreate(["--board", "api", "--title", "Связанная T3", "--description", TEXT.unicode]);
const T4 = taskCreate([
  "--board",
  "web",
  "--title",
  "Подзадача T4",
  "--description",
  TEXT.trailing,
  ...(early ? [] : ["--parent-id", T1.id]),
]);
const T5 = taskCreate([
  "--board",
  "product",
  "--title",
  "Задача для удаления",
  "--description",
  "удалить",
]);
const T6 = taskCreate([
  "--board",
  "web",
  "--title",
  "Задача для переноса на другую доску",
  "--description",
  TEXT.markdown,
]);
const T7 = taskCreate([
  "--board",
  "product",
  "--title",
  "Продуктовая задача",
  "--description",
  TEXT.unicode,
  "--feature",
  F1.id,
  "--scenario",
  S1.id,
]);
if (!early)
  run([
    "task",
    "criterion",
    "add",
    T7.key,
    "--title",
    "Невыполненный критерий",
    "--summary",
    "",
    "--description",
    TEXT.trailing,
  ]);
remember("T7", {
  title: "Продуктовая задача",
  description: TEXT.unicode,
  productLinks: [
    ["feature", F1.id],
    ["scenario", S1.id],
  ],
  criteria: early
    ? []
    : [{ title: "Невыполненный критерий", description: TEXT.trailing, completed: false }],
});
for (const [name, task] of Object.entries({ T1, T2, T3, T4, T5, T6, T7 }))
  remember(name, { kind: "task", id: task.id, key: task.key });
remember("T1", {
  title: "Задача с критериями «T1»",
  description: TEXT.crlf,
  boardId: undefined,
  criteria: early
    ? []
    : criteria.map(({ title, summary, description }) => ({ title, summary, description })),
  productLinks: [
    ["implementation", FI1.id],
    ["implementation", SI1.id],
  ],
});
remember("T2", { title: "Зависимость T2", description: TEXT.mixed, column: "ready" });
remember("T3", { title: "Связанная T3", description: TEXT.unicode });
remember("T4", {
  title: "Подзадача T4",
  description: TEXT.trailing,
  parentId: early ? null : T1.id,
});

run(["task", "link", T1.key, "--target", T2.key, "--relation", "depends-on"]);
run(["task", "link", T1.key, "--target", T3.key, "--relation", "related"]);
remember("T1", { dependencies: [T2.id], related: [T3.id] });

// Комментарии: короткий, CRLF, длинный, от разных авторов и ролей.
const comments = [
  { title: "Первый комментарий", description: TEXT.crlf, as: "alice", role: "operator" },
  { title: "Комментарий 🚀 Unicode", description: TEXT.unicode, as: "bob", role: "worker" },
  {
    title: "Длинный комментарий",
    description: longComment(),
    as: "fixture-author",
    role: "orchestrator",
  },
];
oracle.entities.T1.comments = [];
if (!early) {
  for (const comment of comments) {
    const result = run(
      [
        "task",
        "comment",
        "publish",
        T1.key,
        "--title",
        comment.title,
        "--description",
        comment.description,
        "--role",
        comment.role,
      ],
      { as: comment.as },
    );
    oracle.entities.T1.comments.push({
      title: comment.title,
      description: comment.description,
      actor: comment.as,
      actorRole: comment.role,
      commentId: result.commentId,
      taskRevisionAfter: result.revision,
    });
  }
  run(
    [
      "task",
      "comment",
      "publish",
      T2.key,
      "--title",
      "Комментарий T2",
      "--description",
      "Без перевода строки в конце",
      "--role",
      "worker",
    ],
    { as: "carol" },
  );
  remember("T2", {
    comments: [
      { title: "Комментарий T2", description: "Без перевода строки в конце", actor: "carol" },
    ],
  });
}

// Критерий выполнен, T2 закрыта, T6 перенесена на другую доску (новый ключ, прежний — алиас).
const t2 = run(["task", "get", T2.key]);
void t2;
run(["task", "move", T2.key, "--column", "done"]);
remember("T2", { column: "done" });
const criteriaList = early ? [] : run(["task", "criterion", "list", T1.key]);
const firstCriterion = early
  ? null
  : (criteriaList.items ?? criteriaList.criteria ?? criteriaList)[0];
if (!early) run(["task", "criterion", "complete", T1.key, firstCriterion.id]);
remember("T1", { completedCriterionId: firstCriterion?.id ?? null });
const moved = run(["task", "move", T6.key, "--board", "api", "--column", "in-progress"]);
const movedKey = moved.task?.key ?? moved.key;
oracle.aliases[T6.id] = { previous: [T6.key], key: movedKey };
remember("T6", { key: movedKey, aliases: [T6.key], column: "in-progress" });

// Документы: разделы, состояние, закрепление, отношения с описаниями.
const docCreate = (args) => {
  const result = run(["entities", "create", "document", ...args]);
  return { id: result.ref.id, key: result.key };
};
let D1, D2, D3, D4;
if (early) {
  // Ранние документы: links вместо relations, без разделов/состояния/закрепления.
  D1 = docCreate([
    "--name",
    "ТЗ миграции",
    "--summary",
    "Сводка ТЗ",
    "--body",
    TEXT.markdown + TEXT.crlf,
    "--document-kind",
    "specification",
    "--targets",
    F1.key,
    S1.key,
  ]);
  remember("D1", {
    kind: "document",
    ...D1,
    name: "ТЗ миграции",
    body: TEXT.markdown + TEXT.crlf,
    documentKind: "specification",
    links: [
      ["feature", F1.id],
      ["scenario", S1.id],
    ],
  });
  D2 = docCreate(["--name", "Правила", "--body", TEXT.unicode, "--document-kind", "rules"]);
  remember("D2", { kind: "document", ...D2, body: TEXT.unicode, documentKind: "rules" });
} else {
  D1 = docCreate([
    "--name",
    "ТЗ миграции",
    "--summary",
    "Сводка ТЗ",
    "--body",
    TEXT.markdown + TEXT.crlf,
    "--document-kind",
    "specification",
    "--document-status",
    "active",
    "--section-id",
    "specs",
    "--pinned",
    "true",
    "--relations",
    JSON.stringify([
      {
        target: { kind: "feature", id: F1.id },
        type: "references",
        description: "Описание связи\r\nс CRLF\r\n",
      },
      {
        target: { kind: "scenario", id: S1.id },
        type: "documents",
        description: "Документирует сценарий 🚀\n",
      },
      { target: { kind: "task", id: T1.id }, type: "references", description: "" },
    ]),
  ]);
  remember("D1", {
    kind: "document",
    ...D1,
    name: "ТЗ миграции",
    body: TEXT.markdown + TEXT.crlf,
    documentKind: "specification",
    documentStatus: "active",
    sectionId: "specs",
    pinned: true,
    relations: [
      {
        target: ["feature", F1.id],
        type: "references",
        description: "Описание связи\r\nс CRLF\r\n",
      },
      {
        target: ["scenario", S1.id],
        type: "documents",
        description: "Документирует сценарий 🚀\n",
      },
      { target: ["task", T1.id], type: "references", description: "" },
    ],
  });
  D2 = docCreate([
    "--name",
    "Архивные правила",
    "--body",
    TEXT.unicode,
    "--document-kind",
    "rules",
    "--document-status",
    "archived",
    "--section-id",
    "rules",
  ]);
  remember("D2", {
    kind: "document",
    ...D2,
    body: TEXT.unicode,
    documentKind: "rules",
    documentStatus: "archived",
    sectionId: "rules",
    pinned: false,
  });
  D3 = docCreate(["--name", "Документ для удаления", "--body", "x", "--document-kind", "decision"]);
  remember("D3", { kind: "document", ...D3 });

  // Документ с несколькими отношениями к разным видам.
  const manyTargets = [T2, T3, T4, T7].map((task, index) => ({
    target: { kind: "task", id: task.id },
    type: "references",
    description: `Связь №${index}`,
  }));
  manyTargets.push({
    target: { kind: "application", id: A1.id },
    type: "documents",
    description: "Приложение",
  });
  D4 = docCreate([
    "--name",
    "Документ с многими связями",
    "--body",
    TEXT.mixed,
    "--document-kind",
    "research",
    "--relations",
    JSON.stringify(manyTargets),
  ]);
  remember("D4", {
    kind: "document",
    ...D4,
    relationCount: manyTargets.length,
    firstRelation: { target: ["task", T2.id], description: "Связь №0" },
  });
}
// Диагностические связи графа: активная и отозванная (inactive).
const graphVersion = () => run(["graph", "list", "--limit", "1"]).version;
const link1 = run([
  "graph",
  "link",
  "--if-version",
  graphVersion(),
  "--from",
  D2.key,
  "--to",
  F2.key,
  "--type",
  "diagnostic-note",
  "--description",
  "Пояснение\r\nдиагностической связи\n",
]);
const link2 = run([
  "graph",
  "link",
  "--if-version",
  graphVersion(),
  "--from",
  T3.key,
  "--to",
  A2.key,
  "--type",
  "custom-temporary",
  "--description",
  "Будет отозвана",
]);
const link2Id = link2.ids?.[0] ?? link2.edge?.id ?? link2.id;
run(["graph", "unlink", link2Id, "--if-version", graphVersion()]);
oracle.relations.diagnosticActive = {
  id: link1.ids?.[0] ?? link1.edge?.id ?? link1.id,
  from: ["document", D2.id],
  to: ["feature", F2.id],
  type: "diagnostic-note",
  description: "Пояснение\r\nдиагностической связи\n",
  active: true,
};
oracle.relations.diagnosticRevoked = {
  id: link2Id,
  from: ["task", T3.id],
  to: ["application", A2.id],
  type: "custom-temporary",
  active: false,
};

// Сегментированный набор отношений: >256 диагностических рёбер одного владельца (лимит inline).
const bulkTargets = [F1, S1, S2, A1, D1].map((entry) => entry.key);
let bulkCount = 0;
// В legacy-графе нет сегментов владельца; массовые рёбра там только раздувают фикстуру.
for (let batch = 0; batch < (legacy ? 0 : 3); batch++) {
  const operations = [];
  for (let index = 0; index < 100; index++, bulkCount++)
    operations.push({
      action: "add",
      type: `bulk-${String(bulkCount).padStart(3, "0")}`,
      from: T7.key,
      to: bulkTargets[bulkCount % bulkTargets.length],
      description: bulkCount === 0 ? TEXT.crlf : `#${bulkCount}`,
    });
  run(["graph", "apply", "--if-version", graphVersion(), "--json", JSON.stringify(operations)]);
}
if (!legacy)
  oracle.relations.segmentedOwner = {
    from: ["task", T7.id],
    diagnosticCount: bulkCount,
    firstType: "bulk-000",
    firstDescription: TEXT.crlf,
  };

// Удаления: надгробия и резерв ключей.
if (!early) {
  del("task", T5.key);
  del("document", D3.key);
  del("feature", F3.key);
  oracle.deleted.push(
    { kind: "task", id: T5.id, key: T5.key },
    { kind: "document", id: D3.id, key: D3.key },
    { kind: "feature", id: F3.id, key: F3.key },
  );
} else oracle.notes.push("Удаление сущностей появилось в 6e141e1; в этой версии надгробий нет");

if (planning) {
  // Планы: закрытый план с этапами и задачами, активный план, отменённый план.
  const planCreate = (args) => {
    const result = run(["plan", "create", ...args]);
    return {
      id: result.ref?.id ?? result.plan?.id ?? result.id,
      key: result.key ?? result.plan?.key,
      raw: result,
    };
  };
  const P1 = planCreate([
    "--title",
    "План v1 «закрытый»",
    "--summary",
    "Сводка\nплана",
    "--goal",
    TEXT.crlf,
    "--rationale",
    TEXT.unicode,
    "--boundaries",
    TEXT.trailing,
    "--expected-result",
    TEXT.markdown,
    "--scope",
    F1.key,
    A1.key,
    "--participants",
    "alice",
    "bob",
  ]);
  remember("P1", {
    kind: "work-plan",
    id: P1.id,
    key: P1.key,
    title: "План v1 «закрытый»",
    summary: "Сводка\nплана",
    goal: TEXT.crlf,
    rationale: TEXT.unicode,
    boundaries: TEXT.trailing,
    expectedResult: TEXT.markdown,
    scope: [
      ["feature", F1.id],
      ["application", A1.id],
    ],
    participants: ["alice", "bob"],
  });
  const stage = (plan, title, extra = {}) => {
    const result = run([
      "plan",
      "stage",
      "create",
      plan,
      "--title",
      title,
      "--summary",
      extra.summary ?? "",
      "--outcome",
      extra.outcome ?? "",
      "--completion-conditions",
      extra.conditions ?? "",
    ]);
    return { id: result.stageId, raw: result };
  };
  const st1 = stage(P1.key, "Этап 1", {
    summary: "Сводка этапа",
    outcome: TEXT.crlf,
    conditions: TEXT.unicode,
  });
  const st2 = stage(P1.key, "Этап 2 (будет удалён)");
  const st3 = stage(P1.key, "Этап 3");
  const st4 = stage(P1.key, "Этап 4 🚀", { outcome: TEXT.markdown });
  run(["plan", "include", P1.key, st1.id, "--tasks", T1.key, T4.key]);
  run(["plan", "include", P1.key, st3.id, "--tasks", T2.key]);
  run(["plan", "include", P1.key, st4.id, "--tasks", T3.key, movedKey]);
  run(["plan", "stage", "remove", P1.key, st2.id]);
  // Перемещение этапа 4 перед этапом 3: ранги пересчитываются операцией той версии.
  run(["plan", "stage", "move", P1.key, st4.id, "--before", st3.id]);
  run(["plan", "start", P1.key]);
  const p1Stages = run(["plan", "stages", P1.key]);
  oracle.entities.P1.stagesRead = p1Stages;
  // Закрытие плана требует выполненного состава той версии: критерии, дети, зависимости.
  for (const item of criteriaList.items ?? criteriaList.criteria ?? criteriaList)
    if (item.id !== firstCriterion.id) run(["task", "criterion", "complete", T1.key, item.id]);
  for (const key of [T4.key, T3.key, movedKey, T1.key])
    run(["task", "move", key, "--column", "done"]);
  for (const name of ["T1", "T3", "T4", "T6"]) remember(name, { column: "done" });
  remember("T1", { allCriteriaCompleted: true });
  run(["plan", "complete", P1.key, "--result", "Итог плана\r\nс CRLF\r\n"]);
  remember("P1", {
    status: "completed",
    result: "Итог плана\r\nс CRLF\r\n",
    stages: [
      {
        id: st1.id,
        title: "Этап 1",
        summary: "Сводка этапа",
        outcome: TEXT.crlf,
        completionConditions: TEXT.unicode,
        taskIds: [T1.id, T4.id],
      },
      { id: st4.id, title: "Этап 4 🚀", outcome: TEXT.markdown, taskIds: [T3.id, T6.id] },
      { id: st3.id, title: "Этап 3", taskIds: [T2.id] },
    ],
    removedStage: { id: st2.id, title: "Этап 2 (будет удалён)" },
  });

  const P2 = planCreate(["--title", "План v1 активный", "--goal", "Цель", "--scope", A2.key]);
  const p2s1 = stage(P2.key, "Этап A");
  const p2s2 = stage(P2.key, "Этап B");
  run(["plan", "include", P2.key, p2s1.id, "--tasks", T3.key]);
  run(["plan", "include", P2.key, p2s2.id, "--tasks", T1.key]);
  run(["plan", "start", P2.key]);
  remember("P2", {
    kind: "work-plan",
    id: P2.id,
    key: P2.key,
    status: "active",
    stages: [
      { id: p2s1.id, title: "Этап A", taskIds: [T3.id] },
      { id: p2s2.id, title: "Этап B", taskIds: [T1.id] },
    ],
  });

  const P3 = planCreate(["--title", "План отменённый", "--goal", ""]);
  run(["plan", "cancel", P3.key, "--result", "Причина отмены 🚫\n"]);
  remember("P3", {
    kind: "work-plan",
    id: P3.id,
    key: P3.key,
    status: "cancelled",
    result: "Причина отмены 🚫\n",
    stages: [],
  });

  // Связь документа с этапом и планом (inline-отношения документа).
  upd(D2.key, [
    "--relations",
    JSON.stringify([
      { target: { kind: "work-plan", id: P1.id }, type: "references", description: "К плану" },
      ...(separateStages
        ? [
            {
              target: { kind: "plan-stage", id: st1.id },
              type: "documents",
              description: "Материал этапа\r\n",
            },
          ]
        : []),
    ]),
  ]);
  remember("D2", {
    relations: [
      ["work-plan", P1.id, "К плану"],
      ...(separateStages ? [["plan-stage", st1.id, "Материал этапа\r\n"]] : []),
    ],
  });

  // Релизы: выпущенный (снимок) и запланированный.
  const R1 = run([
    "release",
    "create",
    "--title",
    "Релиз 1 «выпущен»",
    "--release-version",
    "1.0.0-фикстура",
    "--plans",
    P1.key,
    "--summary",
    "Сводка\nрелиза",
    "--description",
    TEXT.crlf,
    "--planned-for",
    "2026-10-01",
  ]);
  const R1ref = { id: R1.ref?.id ?? R1.id, key: R1.key };
  run(["release", "publish", R1ref.key]);
  const R1read = run(["release", "get", R1ref.key]);
  remember("R1", {
    kind: "release",
    ...R1ref,
    title: "Релиз 1 «выпущен»",
    version: "1.0.0-фикстура",
    planIds: [P1.id],
    status: "released",
    summary: "Сводка\nрелиза",
    description: TEXT.crlf,
    plannedFor: "2026-10-01",
    read: R1read,
  });
  if (separateStages) {
    // После выпуска текст документа меняется: прежний текст остаётся только в снимке выпуска v1.
    upd(D4.key, ["--body", "Изменено после выпуска\n"]);
    remember("D4", { body: "Изменено после выпуска\n", bodyOnlyInReleaseSnapshot: TEXT.mixed });
  }
  const R2 = run([
    "release",
    "create",
    "--title",
    "Релиз 2 планируемый",
    "--release-version",
    "2.0",
    "--plans",
    P2.key,
  ]);
  remember("R2", {
    kind: "release",
    id: R2.ref?.id ?? R2.id,
    key: R2.key,
    planIds: [P2.id],
    status: "planned",
  });
}

// Старый reindex той же версии удаляет недостижимые страницы копирования индексов (размер фикстуры).
oracle.reindex = legacy ? "нет команды storage reindex в этой версии" : run(["storage", "reindex"]);
// Контрольное чтение старым reader после reindex.
if (planning)
  oracle.oldReader = {
    p1Stages: run(["plan", "stages", oracle.entities.P1.key]),
    p2Stages: run(["plan", "stages", oracle.entities.P2.key]),
  };
save(oraclePath, oracle);
console.log("done", oraclePath);
