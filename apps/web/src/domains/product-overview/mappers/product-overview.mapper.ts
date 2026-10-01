import type {
  ProductOverview as ProductOverviewDto,
  ProductOverviewMetricPage as ProductOverviewMetricPageDto,
  ProductOverviewSnapshot,
} from "@relay/contracts/entities/product";
import type {
  OverviewAffectedTask,
  OverviewBlockerImpact,
  OverviewBoard,
  OverviewBoardWork,
  OverviewDocument,
  OverviewImplementations,
  OverviewMetricEntry,
  OverviewMetricPage,
  OverviewObligationReason,
  OverviewOperator,
  OverviewOperatorPlan,
  OverviewOperatorTask,
  OverviewPassport,
  OverviewPlan,
  OverviewPreview,
  OverviewRelease,
  OverviewTask,
  ProductOverview,
} from "../types/product-overview.type";

type SnapshotDto = ProductOverviewSnapshot;
type PreviewDto<Item> = { total: number; hasMore: boolean; items: Item[] };
type BoardDto = SnapshotDto["boards"]["catalog"]["items"][number];
type TaskDto = SnapshotDto["attention"]["inProgress"]["items"][number];
type DocumentDto = SnapshotDto["documents"]["pinnedActive"]["items"][number];
type PlanDto = SnapshotDto["plans"]["active"]["items"][number];
type ReleaseDto = SnapshotDto["releases"]["upcoming"]["items"][number];
type OperatorDto = SnapshotDto["operator"];
type OperatorTaskDto = OperatorDto["unplannedWork"]["items"][number];
type BlockerImpactDto = OperatorDto["blockerImpact"]["items"][number];
type AffectedTaskDto = BlockerImpactDto["affected"]["items"][number];
type BoardWorkDto = OperatorDto["boardWork"]["boards"]["items"][number];
type OperatorPlanDto = OperatorDto["openPlansComplete"]["items"][number];

/** Коды причин Core в предметные причины невыполненных обязательств. */
const OBLIGATION_REASONS: Record<OperatorTaskDto["reasons"][number], OverviewObligationReason> = {
  CRITERION_INCOMPLETE: "criterion",
  DEPENDENCY_INCOMPLETE: "dependency",
  CHILD_INCOMPLETE: "child",
};

/** Сохраняет полный total и признак продолжения, преобразуя только показанные записи. */
const mapPreview = <Dto, Item>(
  preview: PreviewDto<Dto>,
  mapItem: (item: Dto) => Item,
): OverviewPreview<Item> => ({
  total: preview.total,
  hasMore: preview.hasMore,
  items: preview.items.map(mapItem),
});

const mapPassport = (passport: SnapshotDto["passport"]): OverviewPassport => {
  if (passport.state === "missing") return { state: "missing" };
  const common = {
    key: passport.key,
    name: passport.name,
    revision: passport.revision,
    updatedAt: passport.updatedAt,
  };
  if (passport.state === "filled")
    return {
      ...common,
      state: "filled",
      text: passport.summary,
      isExcerpt: false,
      isTruncated: false,
    };
  return {
    ...common,
    state: "no-summary",
    text: passport.excerpt.text,
    isExcerpt: true,
    isTruncated: passport.excerpt.truncated,
  };
};

const mapImplementations = (
  implementations: SnapshotDto["knowledge"]["featureImplementations"],
): OverviewImplementations => ({
  total: implementations.total,
  active: implementations.active,
  withdrawn: implementations.withdrawn,
  byStatus: { ...implementations.byStatus },
});

const mapBoard = (board: BoardDto): OverviewBoard => ({
  id: board.id,
  prefix: board.prefix,
  slug: board.slug,
  kind: board.kind,
  name: board.name,
  taskCount: board.tasks.total,
  openTaskCount: board.tasks.open,
});

const mapTask = (task: TaskDto): OverviewTask => ({
  id: task.id,
  key: task.key,
  title: task.title,
  column: task.column,
  board: { slug: task.board.slug, name: task.board.name },
  isCompleted: task.completed,
  acceptance: { total: task.acceptance.total, completed: task.acceptance.completed },
  blockers: {
    total: task.blockers.total,
    items: task.blockers.items.map((blocker) => ({
      id: blocker.id,
      key: blocker.key,
      title: blocker.title,
      column: blocker.column,
      relation: blocker.relation,
    })),
  },
});

const mapDocument = (document: DocumentDto): OverviewDocument => ({
  id: document.id,
  key: document.key,
  name: document.name,
  summary: document.summary,
  updatedAt: document.updatedAt,
});

const mapPlan = (plan: PlanDto): OverviewPlan => ({
  id: plan.id,
  key: plan.key,
  title: plan.title,
  description: plan.summary === "" ? plan.goal.text : plan.summary,
  stages: { total: plan.stages.total, completed: plan.stages.completed },
  nextStageTitle: plan.nextStage?.title ?? null,
  tasks: {
    total: plan.counts.total,
    completed: plan.counts.completed,
    blocked: plan.counts.blocked,
    percent: plan.counts.percent,
  },
  isReady: plan.ready,
});

const mapRelease = (release: ReleaseDto): OverviewRelease => ({
  id: release.id,
  key: release.key,
  title: release.title,
  version: release.version,
  plannedFor: release.plannedFor,
  releasedAt: release.releasedAt,
  readiness: {
    total: release.readiness.total,
    ready: release.readiness.ready,
    percent: release.readiness.percent,
    canRelease: release.readiness.canRelease,
  },
});

const mapOperatorTask = (task: OperatorTaskDto): OverviewOperatorTask => ({
  ...mapTask(task),
  reasons: task.reasons.map((reason) => OBLIGATION_REASONS[reason]),
});

const mapAffectedTask = (task: AffectedTaskDto): OverviewAffectedTask => ({
  id: task.id,
  key: task.key,
  title: task.title,
  column: task.column,
  board: { slug: task.board.slug, name: task.board.name },
  relations: [...task.relations],
});

const mapBlockerImpact = (blocker: BlockerImpactDto): OverviewBlockerImpact => ({
  id: blocker.id,
  key: blocker.key,
  title: blocker.title,
  column: blocker.column,
  board: { slug: blocker.board.slug, name: blocker.board.name },
  affected: {
    total: blocker.affected.total,
    items: blocker.affected.items.map(mapAffectedTask),
  },
});

const mapBoardWork = (board: BoardWorkDto): OverviewBoardWork => ({
  id: board.id,
  prefix: board.prefix,
  slug: board.slug,
  kind: board.kind,
  name: board.name,
  tasks: {
    total: board.tasks.total,
    byColumn: { ...board.tasks.byColumn },
    completed: board.tasks.completed,
    remaining: board.tasks.remaining,
    blockedRemaining: board.tasks.blockedRemaining,
    readyToStart: board.tasks.readyToStart,
  },
});

const mapOperatorPlan = (plan: OperatorPlanDto): OverviewOperatorPlan => ({
  id: plan.id,
  key: plan.key,
  title: plan.title,
  status: plan.status,
  stages: { total: plan.stages.total, completed: plan.stages.completed },
  tasks: {
    total: plan.counts.total,
    completed: plan.counts.completed,
    percent: plan.counts.percent,
  },
});

const mapOperator = (operator: OperatorDto): OverviewOperator => ({
  review: {
    total: operator.review.total,
    obligationsMet: mapPreview(operator.review.obligationsMet, mapOperatorTask),
    obligationsOpen: mapPreview(operator.review.obligationsOpen, mapOperatorTask),
  },
  blockerImpact: mapPreview(operator.blockerImpact, mapBlockerImpact),
  unplannedWork: {
    ...mapPreview(operator.unplannedWork, mapOperatorTask),
    byColumn: {
      inProgress: operator.unplannedWork.byColumn["in-progress"],
      review: operator.unplannedWork.byColumn.review,
    },
  },
  boardWork: {
    remaining: operator.boardWork.remaining,
    blockedRemaining: operator.boardWork.blockedRemaining,
    boards: mapPreview(operator.boardWork.boards, mapBoardWork),
  },
  openPlansComplete: mapPreview(operator.openPlansComplete, mapOperatorPlan),
  releasePreparation: {
    readyReleases: mapPreview(operator.releasePreparation.readyReleases, mapRelease),
    completedPlansOutsideReleases: mapPreview(
      operator.releasePreparation.completedPlansOutsideReleases,
      mapOperatorPlan,
    ),
  },
});

/** Записи страницы метрики с видом, по которому интерфейс выбирает отображение. */
const mapMetricEntries = (page: ProductOverviewMetricPageDto): OverviewMetricEntry[] => {
  switch (page.metric) {
    case "review-obligations-met":
    case "review-obligations-open":
    case "unplanned-work":
      return page.items.map((task) => ({ kind: "task", id: task.id, task: mapOperatorTask(task) }));
    case "blocker-affected":
      return page.items.map((task) => ({
        kind: "affected",
        id: task.id,
        task: mapAffectedTask(task),
      }));
    case "blocker-impact":
      return page.items.map((blocker) => ({
        kind: "blocker",
        id: blocker.id,
        blocker: mapBlockerImpact(blocker),
      }));
    case "board-work":
      return page.items.map((board) => ({
        kind: "board",
        id: board.id,
        board: mapBoardWork(board),
      }));
    case "open-plans-complete":
    case "plans-outside-releases":
      return page.items.map((plan) => ({ kind: "plan", id: plan.id, plan: mapOperatorPlan(plan) }));
    case "ready-releases":
      return page.items.map((release) => ({
        kind: "release",
        id: release.id,
        release: mapRelease(release),
      }));
  }
};

/**
 * Преобразует проверенную страницу полного списка метрики в предметные записи.
 */
export const mapOverviewMetricPageDto = (
  page: ProductOverviewMetricPageDto,
): OverviewMetricPage => ({
  snapshotVersion: page.snapshotVersion,
  total: page.total,
  entries: mapMetricEntries(page),
  nextCursor: page.nextCursor,
});

/**
 * Преобразует проверенный ответ сервера в предметный обзор; прежняя карта продукта Web не нужна.
 */
export const mapProductOverviewDto = (dto: ProductOverviewDto): ProductOverview => {
  const { snapshot } = dto;
  return {
    snapshotVersion: dto.snapshotVersion,
    generatedAt: dto.generatedAt,
    project: { name: snapshot.project.name, slug: snapshot.project.slug },
    passport: mapPassport(snapshot.passport),
    knowledge: {
      features: {
        total: snapshot.knowledge.features.total,
        byStatus: { ...snapshot.knowledge.features.byStatus },
      },
      scenarios: {
        total: snapshot.knowledge.scenarios.total,
        byStatus: { ...snapshot.knowledge.scenarios.byStatus },
      },
      applications: {
        total: snapshot.knowledge.applications.total,
        byType: { ...snapshot.knowledge.applications.byType },
      },
      featureImplementations: mapImplementations(snapshot.knowledge.featureImplementations),
      scenarioImplementations: mapImplementations(snapshot.knowledge.scenarioImplementations),
    },
    boards: {
      total: snapshot.boards.total,
      byKind: { ...snapshot.boards.byKind },
      catalog: mapPreview(snapshot.boards.catalog, mapBoard),
    },
    tasks: {
      total: snapshot.tasks.total,
      byColumn: { ...snapshot.tasks.byColumn },
      completed: snapshot.tasks.completed,
      doneWithOpenObligations: snapshot.tasks.doneWithOpenObligations,
      readyToStart: snapshot.tasks.readyToStart,
      blocked: snapshot.tasks.blocked,
      criteria: { ...snapshot.tasks.criteria },
    },
    attention: {
      inProgress: mapPreview(snapshot.attention.inProgress, mapTask),
      review: mapPreview(snapshot.attention.review, mapTask),
      blocked: mapPreview(snapshot.attention.blocked, mapTask),
    },
    documents: {
      total: snapshot.documents.total,
      byStatus: { ...snapshot.documents.byStatus },
      pinned: snapshot.documents.pinned,
      sections: {
        total: snapshot.documents.sections.total,
        unsectioned: snapshot.documents.sections.unsectioned,
      },
      pinnedActive: mapPreview(snapshot.documents.pinnedActive, mapDocument),
    },
    plans: {
      total: snapshot.plans.total,
      byStatus: { ...snapshot.plans.byStatus },
      completedNotReady: snapshot.plans.completedNotReady,
      active: mapPreview(snapshot.plans.active, mapPlan),
    },
    releases: {
      total: snapshot.releases.total,
      byStatus: { ...snapshot.releases.byStatus },
      upcoming: mapPreview(snapshot.releases.upcoming, mapRelease),
      recent: mapPreview(snapshot.releases.recent, mapRelease),
    },
    operator: mapOperator(snapshot.operator),
  };
};
