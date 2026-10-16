import type { WorkGraph } from "domains/work-history";

/** Только реально переданная точка, включая границу и последний openEnd. */
export type VisualHistoryPoint = WorkGraph["items"][number] | WorkGraph["boundaryNodes"][number];
/** Причинное ограничение исключительно внутри одного точного timestamp. */
export type VisualOrderConstraint = {
  /** Более ранняя визуальная точка. */
  before: string;
  /** Более поздняя визуальная точка. */
  after: string;
  /** Общий неизменённый timestamp. */
  at: string;
  /** Основания из переданных полей, не из названий. */
  reasons: string[];
};

/** Явная несогласованность входных ограничений без выдуманного fallback-порядка. */
export class VisualOrdinalCycleError extends Error {
  /** Timestamp конфликтующих точек. */
  readonly at: string;
  /** Полный набор неразрешённых адресов. */
  readonly pointIds: string[];
  /** Причины замкнувшихся ограничений. */
  readonly constraints: VisualOrderConstraint[];
  /**
   * Оставляет диагностируемый отказ вместо незаметного нарушения причинного порядка.
   */
  constructor(at: string, pointIds: string[], constraints: VisualOrderConstraint[]) {
    super(`Цикл визуального порядка при ${at}: ${pointIds.join(", ")}`);
    this.name = "VisualOrdinalCycleError";
    this.at = at;
    this.pointIds = pointIds;
    this.constraints = constraints;
  }
}

/**
 * Стабильное сравнение без зависимости от locale среды.
 */
export const compareVisualText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Разрешает равноправные события серверными идентификаторами и sequence.
 */
const comparePoints = (a: VisualHistoryPoint, b: VisualHistoryPoint): number =>
  compareVisualText(a.sessionId, b.sessionId) ||
  a.sequence - b.sequence ||
  compareVisualText(a.id, b.id);

/**
 * Вычисляет view-only ordinals: времена разных групп не меняются, а внутри одинакового at
 * учитываются sequence, рождение/закрытие родителя и явный контекст fork. Missing points
 * не создаются; acceptance не угадывается. API items, offsets и timestamps остаются нетронутыми.
 */
export const buildVisualOrdinals = (
  graph: WorkGraph,
): { points: VisualHistoryPoint[]; constraints: VisualOrderConstraint[] } => {
  const all = [
    ...new Map<string, VisualHistoryPoint>(
      [...graph.openEnds, ...graph.boundaryNodes, ...graph.items].map((point) => [point.id, point]),
    ).values(),
  ];
  const byId = new Map(all.map((point) => [point.id, point]));
  const bySession = new Map<string, VisualHistoryPoint[]>();
  const byAt = new Map<string, VisualHistoryPoint[]>();
  for (const point of all) {
    if (!Number.isFinite(Date.parse(point.at))) throw new Error(`Неверное время точки ${point.id}`);
    const session = bySession.get(point.sessionId) ?? [];
    session.push(point);
    bySession.set(point.sessionId, session);
    const group = byAt.get(point.at) ?? [];
    group.push(point);
    byAt.set(point.at, group);
  }
  const constraints = new Map<string, VisualOrderConstraint>();
  /**
   * Добавляет только доказанное ограничение между загруженными точками одной at-группы.
   */
  const add = (
    before: VisualHistoryPoint | undefined,
    after: VisualHistoryPoint | undefined,
    reason: string,
  ): void => {
    if (before === undefined || after === undefined || before.at !== after.at) return;
    const key = JSON.stringify([before.id, after.id]);
    const constraint = constraints.get(key) ?? {
      before: before.id,
      after: after.id,
      at: before.at,
      reasons: [],
    };
    if (!constraint.reasons.includes(reason)) constraint.reasons.push(reason);
    constraints.set(key, constraint);
  };
  /**
   * Связывает соседние группы sequence, не создавая произвольного порядка внутри одинакового номера.
   */
  const orderGroups = (
    points: VisualHistoryPoint[],
    sequenceOf: (point: VisualHistoryPoint) => number | undefined,
    reason: string,
  ): void => {
    const groups = new Map<number, VisualHistoryPoint[]>();
    for (const point of points) {
      const sequence = sequenceOf(point);
      if (sequence === undefined) continue;
      const members = groups.get(sequence) ?? [];
      members.push(point);
      groups.set(sequence, members);
    }
    const numbers = [...groups.keys()].sort((a, b) => a - b);
    for (let index = 1; index < numbers.length; index += 1) {
      const previous = numbers[index - 1];
      const current = numbers[index];
      if (previous === undefined || current === undefined) continue;
      for (const before of groups.get(previous) ?? [])
        for (const after of groups.get(current) ?? []) add(before, after, reason);
    }
  };
  for (const group of byAt.values())
    for (const id of new Set(group.map((point) => point.sessionId)))
      orderGroups(
        group.filter((point) => point.sessionId === id),
        (point) => point.sequence,
        "session-sequence",
      );
  const forks = new Map<string, { point: VisualHistoryPoint; sequence: number }[]>();
  for (const child of [...graph.branches].sort((a, b) => compareVisualText(a.id, b.id))) {
    if (child.parentSessionId === null) continue;
    const parentPoints = bySession.get(child.parentSessionId) ?? [];
    const childPoints = bySession.get(child.id) ?? [];
    for (const birth of childPoints.filter((point) => point.kind === "session-created")) {
      for (const parentBirth of parentPoints.filter((point) => point.kind === "session-created"))
        add(parentBirth, birth, "parent-birth");
      if (child.originCheckpointId !== null)
        add(
          parentPoints.find(
            (point) =>
              ("checkpointId" in point && point.checkpointId === child.originCheckpointId) ||
              point.id === `${child.originCheckpointId}:checkpoint`,
          ),
          birth,
          "origin-intent",
        );
      const sequence = child.parentSequence;
      if (sequence !== null) {
        const lower = parentPoints.filter((point) => point.sequence < sequence);
        const upper = parentPoints.filter((point) => point.sequence > sequence);
        const lowerSequence = Math.max(-Infinity, ...lower.map((point) => point.sequence));
        const upperSequence = Math.min(Infinity, ...upper.map((point) => point.sequence));
        for (const point of lower.filter((point) => point.sequence === lowerSequence))
          add(point, birth, "parent-sequence-before-fork");
        for (const point of upper.filter((point) => point.sequence === upperSequence))
          add(birth, point, "parent-sequence-after-fork");
        const entries = forks.get(child.parentSessionId) ?? [];
        entries.push({ point: birth, sequence });
        forks.set(child.parentSessionId, entries);
      }
    }
    for (const closed of childPoints.filter((point) => point.kind === "session-closed"))
      for (const parentClosed of parentPoints.filter((point) => point.kind === "session-closed"))
        add(closed, parentClosed, "child-close-before-parent");
  }
  for (const entries of forks.values())
    for (const at of new Set(entries.map((entry) => entry.point.at))) {
      const sameAt = entries.filter((entry) => entry.point.at === at);
      const sequenceById = new Map(sameAt.map((entry) => [entry.point.id, entry.sequence]));
      orderGroups(
        sameAt.map((entry) => entry.point),
        (point) => sequenceById.get(point.id),
        "sibling-fork-parent-sequence",
      );
    }
  const orderedConstraints = [...constraints.values()]
    .map((constraint) => ({
      ...constraint,
      reasons: [...constraint.reasons].sort(compareVisualText),
    }))
    .sort(
      (a, b) =>
        compareVisualText(a.at, b.at) ||
        compareVisualText(a.before, b.before) ||
        compareVisualText(a.after, b.after),
    );
  const ordered: VisualHistoryPoint[] = [];
  for (const at of [...byAt.keys()].sort(
    (a, b) => Date.parse(a) - Date.parse(b) || compareVisualText(a, b),
  )) {
    const group = byAt.get(at) ?? [];
    const outgoing = new Map(group.map((point) => [point.id, new Set<string>()]));
    const degrees = new Map(group.map((point) => [point.id, 0]));
    const edges = orderedConstraints.filter((constraint) => constraint.at === at);
    for (const edge of edges) {
      outgoing.get(edge.before)?.add(edge.after);
      degrees.set(edge.after, (degrees.get(edge.after) ?? 0) + 1);
    }
    const ready = group.filter((point) => degrees.get(point.id) === 0).sort(comparePoints);
    const local: VisualHistoryPoint[] = [];
    while (ready[0] !== undefined) {
      const point = ready.shift();
      if (point === undefined) break;
      local.push(point);
      for (const id of outgoing.get(point.id) ?? []) {
        const degree = (degrees.get(id) ?? 0) - 1;
        degrees.set(id, degree);
        const next = byId.get(id);
        if (degree === 0 && next !== undefined) ready.push(next);
      }
      ready.sort(comparePoints);
    }
    if (local.length !== group.length) {
      const ids = group
        .filter((point) => (degrees.get(point.id) ?? 0) > 0)
        .sort(comparePoints)
        .map((point) => point.id);
      const unresolved = new Set(ids);
      throw new VisualOrdinalCycleError(
        at,
        ids,
        edges.filter((edge) => unresolved.has(edge.before) && unresolved.has(edge.after)),
      );
    }
    ordered.push(...local);
  }
  return { points: ordered, constraints: orderedConstraints };
};
