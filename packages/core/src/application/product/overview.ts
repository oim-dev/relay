import { createHash } from "node:crypto";
import {
  PRODUCT_OVERVIEW_EXCERPT_LIMIT,
  PRODUCT_OVERVIEW_PREVIEW_LIMIT,
  productOverviewSchema,
} from "@relay/contracts/entities/product";
import type { ProductOverview, ProductOverviewSnapshot } from "@relay/contracts/entities/product";
import { defaultDocumentSections } from "@relay/contracts/entities";
import type { WorkPlan } from "@relay/contracts/planning";
import type { Release } from "@relay/contracts/releases";
import type { BoardView } from "../../domain/board.js";
import type { BoardTaskRecord } from "../../domain/board-task.js";
import type { ProductRecord, ProductState } from "../../domain/product.js";
import type { ProjectSettings } from "../../domain/project-settings.js";
import { invariant } from "../../shared/errors.js";
import { BoardRepository } from "../../storage/boards.js";
import { BoardTaskRepository } from "../../storage/board-tasks.js";
import { planningRecords } from "../../storage/planning.js";
import { ProductRepository } from "../../storage/product.js";
import { projectSettings } from "../../storage/project-settings.js";
import type { Workspace } from "../../storage/workspace.js";
import { taskCompletions } from "../board-tasks/completion.js";
import type { TaskCompletion } from "../board-tasks/completion.js";
import { boardViews } from "../boards/service.js";
import { planningCountsCompleted, readPlanningState } from "../planning/model.js";
import type { PlanningState } from "../planning/model.js";
import { releaseComposition } from "../releases/model.js";
import { productState, validateProduct } from "./model.js";

/** Все исходные данные одного согласованного чтения обзора. */
export type OverviewSources = {
  /** Постоянный ID проекта из конфигурации; null у прежней конфигурации. */
  projectId: string | null;
  /** Имя, slug и разделы проекта на момент чтения. */
  settings: ProjectSettings;
  /** ID продукта хранилища. */
  productId: string;
  /** Записи продукта в дисковом порядке репозитория. */
  records: ProductRecord[];
  /** Все задачи проекта. */
  tasks: BoardTaskRecord[];
  /** Представления всех досок в порядке каталога. */
  boards: BoardView[];
  /** Все планы работ; пусто для прежнего формата без планирования. */
  plans: WorkPlan[];
  /** Все релизы; пусто для прежнего формата без планирования. */
  releases: Release[];
  /** Предметный снимок планирования либо null для прежнего формата. */
  planning: PlanningState | null;
};

/**
 * Читает все источники обзора. Вызывается только внутри `workspace.locked`:
 * тогда паспорт, задачи, доски, документы, планы и релизы принадлежат одному состоянию.
 */
export async function readOverviewSources(
  workspace: Workspace,
  assertOwned: () => void,
): Promise<OverviewSources> {
  const repository = new ProductRepository(workspace);
  const records = await repository.ensureKeys(assertOwned);
  validateProduct(records);
  const tasks = await new BoardTaskRepository(workspace).all();
  const boards = boardViews(await new BoardRepository(workspace).all(), records);
  const planning = workspace.storageSession ? await readPlanningState(workspace, tasks) : null;
  return {
    projectId: workspace.config.projectId ?? null,
    settings: projectSettings(workspace.config, workspace.configPath),
    productId: repository.productId,
    records,
    tasks,
    boards,
    plans: planning?.plans ?? [],
    releases: await planningRecords(workspace, "release"),
    planning,
  };
}

const byId = <T extends { id: string }>(items: readonly T[]) =>
  [...items].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

/**
 * Отпечаток всех данных, влияющих на любой блок обзора. Порядок записей нормализуется,
 * время формирования ответа не входит; повторное чтение неизменного состояния даёт ту же версию.
 */
export function overviewSnapshotVersion(sources: OverviewSources): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "product-overview/1",
        sources.projectId,
        sources.settings,
        sources.productId,
        byId(sources.records),
        byId(sources.tasks),
        byId(sources.boards),
        byId(sources.plans),
        byId(sources.releases),
      ]),
    )
    .digest("hex");
}

/** Начало сохранённого текста без генерации смысла: обрезка краёв и не более 600 символов. */
export function overviewExcerpt(source: string) {
  const trimmed = source.trim();
  const characters = [...trimmed];
  return characters.length <= PRODUCT_OVERVIEW_EXCERPT_LIMIT
    ? { text: trimmed, truncated: false }
    : {
        text: characters.slice(0, PRODUCT_OVERVIEW_EXCERPT_LIMIT).join("").trimEnd(),
        truncated: true,
      };
}

function preview<T>(items: readonly T[]) {
  const shown = items.slice(0, PRODUCT_OVERVIEW_PREVIEW_LIMIT);
  return {
    total: items.length,
    shown: shown.length,
    hasMore: items.length > shown.length,
    items: shown,
  };
}

/** Новые изменения первыми, постоянный ID разрешает равенство. */
const recentFirst = <T extends { id: string; updatedAt: string }>(left: T, right: T) =>
  right.updatedAt.localeCompare(left.updatedAt) ||
  (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

const columnPriority: Record<BoardTaskRecord["column"], number> = {
  "in-progress": 0,
  review: 1,
  ready: 2,
  inbox: 3,
  done: 4,
  cancelled: 5,
};

/**
 * Чистый расчёт среза из уже прочитанных источников. Выполнение задач считается один раз
 * по действующему правилу обязательств; готовность требований берётся из `productState`.
 */
export function buildProductOverview(
  sources: OverviewSources,
  generatedAt: string,
): ProductOverview {
  const state: ProductState = productState(sources.productId, sources.records, sources.tasks);
  const completion: Map<string, TaskCompletion> = taskCompletions(sources.tasks, "blocked");
  const boardsById = new Map(sources.boards.map((board) => [board.id, board]));
  const tasksById = new Map(sources.tasks.map((task) => [task.id, task]));
  const readiness = new Map(state.readiness.map((entry) => [entry.id, entry.status]));

  const passportRecord = sources.records.find((record) => record.fields.kind === "passport");
  let passport: ProductOverviewSnapshot["passport"] = { state: "missing" };
  if (passportRecord?.fields.kind === "passport") {
    const fields = passportRecord.fields;
    const common = {
      id: passportRecord.id,
      key: passportRecord.key ?? null,
      revision: passportRecord.revision,
      name: fields.name,
      updatedAt: passportRecord.updatedAt,
    };
    passport =
      fields.summary.trim() === ""
        ? { state: "no-summary", ...common, excerpt: overviewExcerpt(fields.description) }
        : { state: "filled", ...common, summary: fields.summary };
  }

  const statusCounts = (ids: string[]) => {
    const counts = { none: 0, partial: 0, done: 0 };
    for (const id of ids) counts[readiness.get(id) ?? "none"]++;
    return counts;
  };
  const kindIds = (kind: ProductRecord["fields"]["kind"]) =>
    sources.records.filter((record) => record.fields.kind === kind).map((record) => record.id);
  const featureIds = kindIds("feature");
  const scenarioIds = kindIds("scenario");
  const applicationTypes = { frontend: 0, backend: 0, internal: 0 };
  for (const record of sources.records)
    if (record.fields.kind === "application") applicationTypes[record.fields.type]++;
  const contracts = state.records.flatMap((record) =>
    record.fields.kind === "scope" ? record.fields.contracts : [],
  );
  const implementationCounts = (scenarioLevel: boolean) => {
    const selected = contracts.filter((entry) => (entry.scenarioId !== null) === scenarioLevel);
    const active = selected.filter((entry) => entry.active);
    const byStatus = { none: 0, partial: 0, done: 0 };
    // В состоянии productState поле status уже заменено вычисленной готовностью по задачам.
    for (const entry of active) byStatus[entry.status]++;
    return {
      total: selected.length,
      active: active.length,
      withdrawn: selected.length - active.length,
      byStatus,
    };
  };

  const boardTasks = new Map<string, { total: number; open: number }>();
  for (const board of sources.boards) boardTasks.set(board.id, { total: 0, open: 0 });
  const byColumn = { inbox: 0, ready: 0, "in-progress": 0, review: 0, done: 0, cancelled: 0 };
  const criteria = { total: 0, completed: 0, pending: 0, tasksWithPending: 0 };
  let completed = 0;
  let doneWithOpenObligations = 0;
  let readyToStart = 0;
  let blocked = 0;
  for (const task of sources.tasks) {
    const counts = boardTasks.get(task.boardId);
    invariant(counts, "INVALID_DATA", `Задача ${task.key} ссылается на отсутствующую доску`, 5);
    counts.total++;
    if (task.column !== "done" && task.column !== "cancelled") counts.open++;
    byColumn[task.column]++;
    const result = completion.get(task.id)!;
    if (result.completed) completed++;
    if (task.column === "done" && !result.completed) doneWithOpenObligations++;
    if (result.blockers.length > 0) blocked++;
    if (task.column === "ready" && result.blockers.length === 0) readyToStart++;
    if (task.column !== "cancelled") {
      const done = task.acceptanceCriteria.filter((entry) => entry.completed).length;
      criteria.total += task.acceptanceCriteria.length;
      criteria.completed += done;
      criteria.pending += task.acceptanceCriteria.length - done;
      if (done < task.acceptanceCriteria.length) criteria.tasksWithPending++;
    }
  }

  const taskRef = (task: BoardTaskRecord) => ({
    id: task.id,
    key: task.key,
    title: task.title,
    column: task.column,
  });
  const attentionCard = (task: BoardTaskRecord) => {
    const board = boardsById.get(task.boardId)!;
    const blockers = completion.get(task.id)!.blockers;
    return {
      ...taskRef(task),
      board: { id: board.id, prefix: board.prefix, slug: board.slug, name: board.name },
      updatedAt: task.updatedAt,
      completed: completion.get(task.id)!.completed,
      acceptance: {
        total: task.acceptanceCriteria.length,
        completed: task.acceptanceCriteria.filter((entry) => entry.completed).length,
      },
      blockers: {
        total: blockers.length,
        items: blockers.slice(0, PRODUCT_OVERVIEW_PREVIEW_LIMIT).map((id) => ({
          ...taskRef(tasksById.get(id)!),
          relation: task.dependencies.includes(id) ? ("dependency" as const) : ("subtask" as const),
        })),
      },
    };
  };
  const attentionList = (
    filter: (task: BoardTaskRecord) => boolean,
    order: (left: BoardTaskRecord, right: BoardTaskRecord) => number = recentFirst,
  ) => {
    const selected = sources.tasks.filter(filter).sort(order);
    const page = preview(selected);
    return { ...page, items: page.items.map(attentionCard) };
  };

  const documents = sources.records.filter((record) => record.fields.kind === "document");
  const documentStatus = { draft: 0, active: 0, archived: 0 };
  const configuredSections = sources.settings.documentSections ?? defaultDocumentSections;
  const sectionCounts = new Map(configuredSections.map((section) => [section.id, 0]));
  let pinned = 0;
  let unsectioned = 0;
  for (const record of documents) {
    if (record.fields.kind !== "document") continue;
    documentStatus[record.fields.documentStatus ?? "active"]++;
    if (record.fields.pinned) pinned++;
    const section = record.fields.sectionId ?? null;
    if (section !== null && sectionCounts.has(section))
      sectionCounts.set(section, sectionCounts.get(section)! + 1);
    else unsectioned++;
  }
  const pinnedActive = preview(
    documents
      .filter(
        (record) =>
          record.fields.kind === "document" &&
          record.fields.pinned === true &&
          (record.fields.documentStatus ?? "active") === "active",
      )
      .sort(recentFirst),
  );

  const planStatus = { draft: 0, active: 0, completed: 0, cancelled: 0 };
  let completedNotReady = 0;
  for (const plan of sources.plans) {
    planStatus[plan.status]++;
    if (plan.status === "completed" && !sources.planning!.summary(plan).ready) completedNotReady++;
  }
  const activePlans = preview(
    sources.plans.filter((plan) => plan.status === "active").sort(recentFirst),
  );

  const releaseStatus = { planned: 0, released: 0, cancelled: 0 };
  for (const release of sources.releases) releaseStatus[release.status]++;
  const releaseCard = (release: Release) => {
    const readiness = releaseComposition(release.planIds, sources.planning!).readiness;
    return {
      id: release.id,
      key: release.key,
      title: release.title,
      version: release.version,
      status: release.status,
      plannedFor: release.plannedFor === "" ? null : release.plannedFor,
      releasedAt: release.releasedAt,
      updatedAt: release.updatedAt,
      readiness: {
        ...readiness,
        canRelease: release.status === "planned" && readiness.canRelease,
      },
    };
  };
  const upcoming = preview(
    sources.releases
      .filter((release) => release.status === "planned")
      .sort(
        (left, right) =>
          Number(left.plannedFor === "") - Number(right.plannedFor === "") ||
          left.plannedFor.localeCompare(right.plannedFor) ||
          recentFirst(left, right),
      ),
  );
  const recent = preview(
    sources.releases
      .filter((release) => release.status === "released")
      .sort(
        (left, right) =>
          (right.releasedAt ?? "").localeCompare(left.releasedAt ?? "") || recentFirst(left, right),
      ),
  );

  const catalog = preview(sources.boards);
  const overview: ProductOverview = {
    productId: state.productId,
    version: state.version,
    readiness: state.readiness,
    items: state.records.map(({ id, key, revision, fields }) => ({
      id,
      ...(key ? { key } : {}),
      revision,
      kind: fields.kind,
      name: "name" in fields ? fields.name : "Состав реализации",
      summary: "summary" in fields ? fields.summary : "",
    })),
    snapshotVersion: overviewSnapshotVersion(sources),
    generatedAt,
    snapshot: {
      project: {
        id: sources.projectId,
        name: sources.settings.name,
        slug: sources.settings.slug,
      },
      passport,
      knowledge: {
        features: { total: featureIds.length, byStatus: statusCounts(featureIds) },
        scenarios: { total: scenarioIds.length, byStatus: statusCounts(scenarioIds) },
        applications: {
          total: applicationTypes.frontend + applicationTypes.backend + applicationTypes.internal,
          byType: applicationTypes,
        },
        featureImplementations: implementationCounts(false),
        scenarioImplementations: implementationCounts(true),
      },
      boards: {
        total: sources.boards.length,
        byKind: {
          product: sources.boards.filter((board) => board.kind === "product").length,
          application: sources.boards.filter((board) => board.kind === "application").length,
          infrastructure: sources.boards.filter((board) => board.kind === "infrastructure").length,
        },
        catalog: {
          ...catalog,
          items: catalog.items.map((board) => ({
            id: board.id,
            prefix: board.prefix,
            slug: board.slug,
            kind: board.kind,
            name: board.name,
            applicationId: board.applicationId,
            tasks: boardTasks.get(board.id)!,
          })),
        },
      },
      tasks: {
        total: sources.tasks.length,
        byColumn,
        completed,
        doneWithOpenObligations,
        readyToStart,
        blocked,
        criteria,
      },
      attention: {
        inProgress: attentionList((task) => task.column === "in-progress"),
        review: attentionList((task) => task.column === "review"),
        blocked: attentionList(
          (task) => completion.get(task.id)!.blockers.length > 0,
          (left, right) =>
            columnPriority[left.column] - columnPriority[right.column] || recentFirst(left, right),
        ),
      },
      documents: {
        total: documents.length,
        byStatus: documentStatus,
        pinned,
        sections: {
          total: configuredSections.length,
          unsectioned,
          items: configuredSections.map((section) => ({
            id: section.id,
            name: section.name,
            documents: sectionCounts.get(section.id)!,
          })),
        },
        pinnedActive: {
          ...pinnedActive,
          items: pinnedActive.items.map((record) => {
            invariant(record.fields.kind === "document", "INVALID_DATA", "Ожидается документ", 5);
            return {
              id: record.id,
              key: record.key ?? null,
              name: record.fields.name,
              summary: record.fields.summary,
              documentKind: record.fields.documentKind,
              sectionId:
                record.fields.sectionId != null && sectionCounts.has(record.fields.sectionId)
                  ? record.fields.sectionId
                  : null,
              updatedAt: record.updatedAt,
            };
          }),
        },
      },
      plans: {
        total: sources.plans.length,
        byStatus: planStatus,
        completedNotReady,
        active: {
          ...activePlans,
          items: activePlans.items.map((plan) => {
            const state = sources.planning!;
            const summary = state.summary(plan);
            return {
              id: plan.id,
              key: plan.key,
              title: plan.title,
              summary: plan.summary,
              goal: overviewExcerpt(plan.goal),
              status: plan.status,
              updatedAt: plan.updatedAt,
              stages: {
                total: plan.stages.length,
                completed: plan.stages.filter((stage) =>
                  planningCountsCompleted(state.counts(stage.taskIds)),
                ).length,
              },
              nextStage: summary.nextStage,
              counts: summary.counts,
              ready: summary.ready,
            };
          }),
        },
      },
      releases: {
        total: sources.releases.length,
        byStatus: releaseStatus,
        upcoming: { ...upcoming, items: upcoming.items.map(releaseCard) },
        recent: { ...recent, items: recent.items.map(releaseCard) },
      },
    },
  };
  // Runtime-проверка формы: ошибка расчёта не должна уйти потребителям как «успешные нули».
  return productOverviewSchema.parse(overview);
}
