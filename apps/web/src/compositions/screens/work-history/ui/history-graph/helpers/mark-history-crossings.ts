import type { XYPosition } from "@xyflow/react";
import type { HistoryEdgeGap, HistoryFlowEdge } from "../types/history-flow.type";

/** Прямой участок уже рассчитанного маршрута ELK. */
type RouteSegment = {
  /** Владелец участка. */
  edge: HistoryFlowEdge;
  /** Номер section. */
  section: number;
  /** Индекс конечной точки сегмента. */
  segment: number;
  /** Начало в координатах ELK. */
  from: XYPosition;
  /** Конец в координатах ELK. */
  to: XYPosition;
};

/** Радиус разрыва различим при рабочем масштабе и меньше скругления маршрута. */
const GAP_RADIUS = 5;
/** Разрыв не затрагивает углы и endpoints, которые могут быть настоящими соединениями. */
const CORNER_CLEARANCE = 8;

/**
 * Выбирает верхнюю линию: ось, незавершённая работа, затем вертикальный ствол при равенстве.
 */
const priority = (segment: RouteSegment): number =>
  segment.edge.data?.kind === "axis" ? 2 : segment.edge.data?.isUnfinished ? 1 : 0;

/**
 * Помечает только внутренние пересечения независимых прямых сегментов. ELK-координаты,
 * связи и endpoints остаются исходными; разрыв лишь отличает пересечение от fork/join.
 */
export const markHistoryCrossings = (edges: HistoryFlowEdge[]): HistoryFlowEdge[] => {
  const vertical: RouteSegment[] = [];
  const horizontal: RouteSegment[] = [];
  for (const edge of edges) {
    for (const [section, points] of (edge.data?.sections ?? []).entries()) {
      for (let segment = 1; segment < points.length; segment += 1) {
        const from = points[segment - 1];
        const to = points[segment];
        if (from === undefined || to === undefined) continue;
        const entry = { edge, section, segment, from, to };
        if (Math.abs(from.x - to.x) < 0.5 && Math.abs(from.y - to.y) > 0.5) vertical.push(entry);
        else if (Math.abs(from.y - to.y) < 0.5 && Math.abs(from.x - to.x) > 0.5)
          horizontal.push(entry);
      }
    }
  }
  vertical.sort((a, b) => a.from.x - b.from.x);
  const gaps = new Map<string, HistoryEdgeGap[]>();
  for (const across of horizontal) {
    const left = Math.min(across.from.x, across.to.x);
    const right = Math.max(across.from.x, across.to.x);
    const y = across.from.y;
    let low = 0;
    let high = vertical.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = vertical[middle];
      if (candidate !== undefined && candidate.from.x <= left + 0.5) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < vertical.length; index += 1) {
      const along = vertical[index];
      if (along === undefined || along.from.x >= right - 0.5) break;
      if (along.edge.id === across.edge.id) continue;
      const top = Math.min(along.from.y, along.to.y);
      const bottom = Math.max(along.from.y, along.to.y);
      if (y <= top + 0.5 || y >= bottom - 0.5) continue;
      const under = priority(across) > priority(along) ? along : across;
      const x = along.from.x;
      const offset = Math.hypot(x - under.from.x, y - under.from.y);
      const remaining = Math.hypot(x - under.to.x, y - under.to.y);
      const radius = Math.min(GAP_RADIUS, offset - CORNER_CLEARANCE, remaining - CORNER_CLEARANCE);
      if (radius < 1) continue;
      const entries = gaps.get(under.edge.id) ?? [];
      entries.push({ section: under.section, segment: under.segment, offset, radius });
      gaps.set(under.edge.id, entries);
    }
  }
  return edges.map((edge) =>
    edge.data === undefined
      ? edge
      : {
          ...edge,
          data: { ...edge.data, gaps: gaps.get(edge.id) ?? [] },
        },
  );
};
