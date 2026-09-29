import type {
  ProductOverview as ProductOverviewDto,
  ProductOverviewSnapshot,
} from "@relay/contracts/entities/product";
import type {
  OverviewBoard,
  OverviewDocument,
  OverviewImplementations,
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
  };
};
