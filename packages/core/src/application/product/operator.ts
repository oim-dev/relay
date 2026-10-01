import type {
  ProductOverviewMetric,
  ProductOverviewOperator,
  ProductOverviewSnapshot,
} from "@relay/contracts/entities/product";
import type { Release } from "@relay/contracts/releases";
import type { WorkPlan } from "@relay/contracts/planning";
import type { BoardTaskRecord } from "../../domain/board-task.js";
import { AppError, invariant } from "../../shared/errors.js";
import { taskCompletions } from "../board-tasks/completion.js";
import type { TaskCompletion } from "../board-tasks/completion.js";
import { resolveAddress } from "../entities/resolver.js";
import { planningCountsCompleted } from "../planning/model.js";
import type { PlanningState } from "../planning/model.js";
import { releaseComposition } from "../releases/model.js";
import type { OverviewSources } from "./overview.js";

type Snapshot = ProductOverviewSnapshot;
type Operator = ProductOverviewOperator;
/** Карточка задачи «требует внимания» без основания включения метрики. */
export type OverviewTaskCard = Snapshot["attention"]["review"]["items"][number];
export type OperatorTask = Operator["review"]["obligationsMet"]["items"][number];
export type BlockerImpact = Operator["blockerImpact"]["items"][number];
export type AffectedTask = BlockerImpact["affected"]["items"][number];
export type BoardWork = Operator["boardWork"]["boards"]["items"][number];
export type OperatorPlan = Operator["openPlansComplete"]["items"][number];
export type OverviewRelease = Snapshot["releases"]["upcoming"]["items"][number];
export type BlockerAddress = Pick<AffectedTask, "id" | "key" | "title" | "column" | "board">;

/** Ограничение preview внутри элемента: причины и затронутые задачи. */
const NESTED_LIMIT = 5;

const compareIds = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** Новые изменения первыми, постоянный ID разрешает равенство. */
export const recentFirst = <T extends { id: string; updatedAt: string }>(left: T, right: T) =>
  right.updatedAt.localeCompare(left.updatedAt) || compareIds(left.id, right.id);

/**
 * Выполнение задач считается один раз на чтение. Снимок планирования уже содержит расчёт
 * по тем же задачам (с ошибкой на цикле); без планирования циклы трактуются как блокировка.
 */
export function overviewCompletion(sources: OverviewSources): Map<string, TaskCompletion> {
  return sources.planning?.completion ?? taskCompletions(sources.tasks, "blocked");
}

type PlanSummary = ReturnType<PlanningState["summary"]>;

/** Снимок планирования с запомненной сводкой: каждый план считается один раз на чтение. */
export function memoizedPlanning(planning: PlanningState | null): PlanningState | null {
  if (!planning) return null;
  const cache = new Map<string, PlanSummary>();
  return {
    ...planning,
    summary: (plan: WorkPlan) => {
      let summary = cache.get(plan.id);
      if (!summary) {
        summary = planning.summary(plan);
        cache.set(plan.id, summary);
      }
      return summary;
    },
  };
}

/** Общие построители карточек задач, досок, планов и релизов для обзора и детализации. */
export function overviewCards(
  sources: OverviewSources,
  completion: Map<string, TaskCompletion>,
  planning: PlanningState | null,
) {
  const boardsById = new Map(sources.boards.map((board) => [board.id, board]));
  const tasksById = new Map(sources.tasks.map((task) => [task.id, task]));
  const taskRef = (task: BoardTaskRecord) => ({
    id: task.id,
    key: task.key,
    title: task.title,
    column: task.column,
  });
  const boardRef = (task: BoardTaskRecord) => {
    const board = boardsById.get(task.boardId)!;
    return { id: board.id, prefix: board.prefix, slug: board.slug, name: board.name };
  };
  const taskCard = (task: BoardTaskRecord): OverviewTaskCard => {
    const result = completion.get(task.id)!;
    return {
      ...taskRef(task),
      board: boardRef(task),
      updatedAt: task.updatedAt,
      completed: result.completed,
      acceptance: {
        total: task.acceptanceCriteria.length,
        completed: task.acceptanceCriteria.filter((entry) => entry.completed).length,
      },
      blockers: {
        total: result.blockers.length,
        items: result.blockers.slice(0, NESTED_LIMIT).map((id) => ({
          ...taskRef(tasksById.get(id)!),
          relation: task.dependencies.includes(id) ? ("dependency" as const) : ("subtask" as const),
        })),
      },
    };
  };
  const reasons = (task: BoardTaskRecord): OperatorTask["reasons"] => {
    const result = completion.get(task.id)!;
    const list: OperatorTask["reasons"] = [];
    if (task.acceptanceCriteria.some((entry) => !entry.completed))
      list.push("CRITERION_INCOMPLETE");
    if (result.blockers.some((id) => task.dependencies.includes(id)))
      list.push("DEPENDENCY_INCOMPLETE");
    if (result.blockers.some((id) => tasksById.get(id)?.parentId === task.id))
      list.push("CHILD_INCOMPLETE");
    return list;
  };
  const operatorTask = (task: BoardTaskRecord): OperatorTask => ({
    ...taskCard(task),
    reasons: reasons(task),
  });
  const operatorPlan = (plan: WorkPlan): OperatorPlan => {
    const summary = planning!.summary(plan);
    return {
      id: plan.id,
      key: plan.key,
      title: plan.title,
      status: plan.status,
      updatedAt: plan.updatedAt,
      stages: {
        total: plan.stages.length,
        completed: plan.stages.filter((stage) =>
          planningCountsCompleted(planning!.counts(stage.taskIds)),
        ).length,
      },
      counts: summary.counts,
    };
  };
  const releaseCard = (release: Release): OverviewRelease => {
    const readiness = releaseComposition(release.planIds, planning!).readiness;
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
  return {
    tasksById,
    boardsById,
    taskRef,
    boardRef,
    taskCard,
    operatorTask,
    operatorPlan,
    releaseCard,
  };
}

/** Полные отсортированные списки метрик оператора одного согласованного чтения. */
export type OperatorIndex = {
  reviewTotal: number;
  lists: Record<Exclude<ProductOverviewMetric, "blocker-affected">, unknown[]> & {
    "review-obligations-met": OperatorTask[];
    "review-obligations-open": OperatorTask[];
    "blocker-impact": BlockerImpact[];
    "unplanned-work": OperatorTask[];
    "board-work": BoardWork[];
    "open-plans-complete": OperatorPlan[];
    "ready-releases": OverviewRelease[];
    "plans-outside-releases": OperatorPlan[];
  };
  /** Обратный индекс: ID блокера → все прямо затронутые незавершённые задачи по порядку. */
  affected: Map<string, AffectedTask[]>;
  unplannedByColumn: { "in-progress": number; review: number };
  remaining: number;
  blockedRemaining: number;
  /** Разрешение ссылки на задачу-блокер в том же чтении. */
  resolveTask(reference: string): BlockerAddress;
};

/**
 * Единая классификация M-01…M-06. Строится за один проход по задачам с подготовленными
 * индексами: обзор берёт из неё подборки, детализация — страницы тех же списков.
 */
export function operatorIndex(
  sources: OverviewSources,
  completion: Map<string, TaskCompletion>,
  planning: PlanningState | null,
): OperatorIndex {
  const cards = overviewCards(sources, completion, planning);
  const { tasksById } = cards;

  const reviewMet: BoardTaskRecord[] = [];
  const reviewOpen: BoardTaskRecord[] = [];
  const unplanned: BoardTaskRecord[] = [];
  const unplannedByColumn = { "in-progress": 0, review: 0 };
  const affectedTasks = new Map<string, BoardTaskRecord[]>();
  const perBoard = new Map<string, BoardWork["tasks"]>();
  for (const board of sources.boards)
    perBoard.set(board.id, {
      total: 0,
      byColumn: { inbox: 0, ready: 0, "in-progress": 0, review: 0, done: 0, cancelled: 0 },
      completed: 0,
      remaining: 0,
      blockedRemaining: 0,
      readyToStart: 0,
    });
  let remaining = 0;
  let blockedRemaining = 0;

  for (const task of sources.tasks) {
    const result = completion.get(task.id)!;
    const board = perBoard.get(task.boardId);
    invariant(board, "INVALID_DATA", `Задача ${task.key} ссылается на отсутствующую доску`, 5);
    board.total++;
    board.byColumn[task.column]++;
    if (result.completed) board.completed++;
    if (task.column === "ready" && result.blockers.length === 0) board.readyToStart++;
    if (task.column === "review") (result.canComplete ? reviewMet : reviewOpen).push(task);
    if (
      (task.column === "in-progress" || task.column === "review") &&
      !planning?.current.has(task.id)
    ) {
      unplanned.push(task);
      unplannedByColumn[task.column]++;
    }
    // U: не отменённые и фактически не выполненные, включая done с открытыми обязательствами.
    if (task.column === "cancelled" || result.completed) continue;
    remaining++;
    board.remaining++;
    if (result.blockers.length > 0) {
      blockedRemaining++;
      board.blockedRemaining++;
    }
    for (const blocker of new Set(result.blockers)) {
      const list = affectedTasks.get(blocker) ?? [];
      list.push(task);
      affectedTasks.set(blocker, list);
    }
  }

  const affected = new Map<string, AffectedTask[]>();
  for (const [blockerId, tasks] of affectedTasks)
    affected.set(
      blockerId,
      tasks.sort(recentFirst).map((task) => {
        const relations: AffectedTask["relations"] = [];
        if (task.dependencies.includes(blockerId)) relations.push("dependency");
        if (tasksById.get(blockerId)!.parentId === task.id) relations.push("subtask");
        return {
          ...cards.taskRef(task),
          board: cards.boardRef(task),
          updatedAt: task.updatedAt,
          relations,
        };
      }),
    );
  const blockerImpact = [...affected]
    .sort(
      ([leftId, left], [rightId, right]) =>
        right.length - left.length || compareIds(leftId, rightId),
    )
    .map(([blockerId, items]) => {
      const blocker = tasksById.get(blockerId)!;
      return {
        ...cards.taskRef(blocker),
        board: cards.boardRef(blocker),
        updatedAt: blocker.updatedAt,
        affected: { total: items.length, items: items.slice(0, NESTED_LIMIT) },
      };
    });

  const boardWork = sources.boards
    .map((board) => ({
      id: board.id,
      prefix: board.prefix,
      slug: board.slug,
      kind: board.kind,
      name: board.name,
      applicationId: board.applicationId,
      tasks: perBoard.get(board.id)!,
    }))
    .sort(
      (left, right) =>
        right.tasks.remaining - left.tasks.remaining || compareIds(left.id, right.id),
    );

  const plans = planning ? sources.plans : [];
  const openPlansComplete = plans
    .filter(
      (plan) =>
        (plan.status === "draft" || plan.status === "active") && planning!.summary(plan).ready,
    )
    .sort(recentFirst)
    .map(cards.operatorPlan);
  const releasedOrPlanned = new Set(
    sources.releases
      .filter((release) => release.status === "planned" || release.status === "released")
      .flatMap((release) => release.planIds),
  );
  const plansOutsideReleases = plans
    .filter(
      (plan) =>
        plan.status === "completed" &&
        planning!.summary(plan).ready &&
        !releasedOrPlanned.has(plan.id),
    )
    .sort(recentFirst)
    .map(cards.operatorPlan);
  const readyReleases = (planning ? sources.releases : [])
    .filter((release) => release.status === "planned")
    .map(cards.releaseCard)
    .filter((release) => release.readiness.canRelease)
    .sort(
      (left, right) =>
        Number(left.plannedFor === null) - Number(right.plannedFor === null) ||
        (left.plannedFor ?? "").localeCompare(right.plannedFor ?? "") ||
        compareIds(left.id, right.id),
    );

  const resolveTask = (reference: string): BlockerAddress => {
    let task: BoardTaskRecord;
    try {
      const resolved = resolveAddress(
        sources.tasks.map((entry) => ({
          ref: { kind: "task", id: entry.id },
          key: entry.key,
          aliases: entry.keys,
        })),
        reference,
        "task",
      );
      task = tasksById.get(resolved.ref.id)!;
    } catch (error) {
      if (error instanceof AppError && error.code === "ENTITY_NOT_FOUND")
        throw new AppError("NOT_FOUND", "Задача-блокер не найдена в выбранном проекте", 3);
      throw error;
    }
    return { ...cards.taskRef(task), board: cards.boardRef(task) };
  };

  return {
    reviewTotal: reviewMet.length + reviewOpen.length,
    lists: {
      "review-obligations-met": reviewMet.sort(recentFirst).map(cards.operatorTask),
      "review-obligations-open": reviewOpen.sort(recentFirst).map(cards.operatorTask),
      "blocker-impact": blockerImpact,
      "unplanned-work": unplanned.sort(recentFirst).map(cards.operatorTask),
      "board-work": boardWork,
      "open-plans-complete": openPlansComplete,
      "ready-releases": readyReleases,
      "plans-outside-releases": plansOutsideReleases,
    },
    affected,
    unplannedByColumn,
    remaining,
    blockedRemaining,
    resolveTask,
  };
}

/** Блок snapshot.operator: подборки из полных списков единой классификации. */
export function operatorSnapshot(
  index: OperatorIndex,
  preview: <T>(items: readonly T[]) => {
    total: number;
    shown: number;
    hasMore: boolean;
    items: T[];
  },
): Operator {
  return {
    review: {
      total: index.reviewTotal,
      obligationsMet: preview(index.lists["review-obligations-met"]),
      obligationsOpen: preview(index.lists["review-obligations-open"]),
    },
    blockerImpact: preview(index.lists["blocker-impact"]),
    unplannedWork: {
      ...preview(index.lists["unplanned-work"]),
      byColumn: index.unplannedByColumn,
    },
    boardWork: {
      remaining: index.remaining,
      blockedRemaining: index.blockedRemaining,
      boards: preview(index.lists["board-work"]),
    },
    openPlansComplete: preview(index.lists["open-plans-complete"]),
    releasePreparation: {
      readyReleases: preview(index.lists["ready-releases"]),
      completedPlansOutsideReleases: preview(index.lists["plans-outside-releases"]),
    },
  };
}
