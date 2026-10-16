import type { WorkGraph, WorkGraphBranch } from "domains/work-history";
import { isNonEmptyArray } from "shared/value-predicates";
import type { HistoryLaneLayout, HistoryLaneReservation } from "../types/history-lanes.type";
import { compareVisualText } from "./build-visual-ordinals";

/**
 * Получает цвет от идентичности ветки и её предка, без зависимости от порядка ответа.
 */
const colorIndexFor = (branch: WorkGraphBranch): number => {
  let hash = 0;
  for (const symbol of `${branch.parentSessionId ?? "project"}:${branch.id}`)
    hash = (Math.imul(hash, 31) + symbol.charCodeAt(0)) >>> 0;
  return hash % 8;
};

/**
 * Закрепляет одну дорожку за всем показанным участком ветки. Незавершённые ветки одного
 * поручения разделены даже без одновременных записей. Закрытые непересекающиеся участки
 * могут переиспользовать колонку, но линия никогда не переходит между колонками.
 * Родительский ствол продолжается выше всей видимой работы потомков.
 */
export const assignHistoryLanes = (
  graph: WorkGraph,
  partitions: Map<string, number>,
): HistoryLaneLayout => {
  const { branches } = graph;
  const lanes = new Map<string, HistoryLaneReservation>();
  const byId = new Map(branches.map((branch) => [branch.id, branch]));
  const ranges = new Map<string, { first: number; last: number }>();
  const rows = new Set(partitions.values());
  /**
   * Расширяет только реально рисуемый участок, а не жизненный интервал сессии.
   */
  const include = (sessionId: string, row: number | undefined): void => {
    if (row === undefined) throw new Error("Нет визуальной строки участка истории");
    rows.add(row);
    const range = ranges.get(sessionId);
    ranges.set(sessionId, {
      first: Math.min(range?.first ?? row, row),
      last: Math.max(range?.last ?? row, row),
    });
  };
  for (const point of [...graph.items, ...graph.boundaryNodes, ...graph.openEnds])
    include(point.sessionId, partitions.get(point.id));
  for (const edge of graph.edges) {
    if (edge.kind === "fork") {
      const row = partitions.get(edge.to);
      include(edge.fromSessionId, row === undefined ? undefined : row - 1);
    }
    if (edge.kind === "branch-end") {
      const row = partitions.get(edge.from);
      include(edge.toSessionId, row === undefined ? undefined : row + 1);
    }
  }
  const children = new Map<string | null, WorkGraphBranch[]>();
  for (const branch of branches) {
    const parent = byId.has(branch.parentSessionId ?? "") ? branch.parentSessionId : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(branch);
    children.set(parent, siblings);
  }
  for (const siblings of children.values())
    siblings.sort(
      (a, b) =>
        compareVisualText(a.createdAt, b.createdAt) ||
        (a.parentSequence ?? 0) - (b.parentSequence ?? 0) ||
        compareVisualText(a.id, b.id),
    );
  const stack = [...(children.get(null) ?? [])].reverse();
  const ordered: WorkGraphBranch[] = [];
  const visited = new Set<string>();
  const colors = new Map<string, number>();
  const roots = new Map<string, string>();
  while (isNonEmptyArray(stack)) {
    const branch = stack.pop();
    if (branch === undefined) break;
    if (visited.has(branch.id)) throw new Error("Цикл родительских веток истории");
    visited.add(branch.id);
    ordered.push(branch);
    let colorIndex = colorIndexFor(branch);
    if (colors.get(branch.parentSessionId ?? "") === colorIndex) colorIndex = (colorIndex + 1) % 8;
    colors.set(branch.id, colorIndex);
    roots.set(branch.id, roots.get(branch.parentSessionId ?? "") ?? branch.id);
    stack.push(...[...(children.get(branch.id) ?? [])].reverse());
  }
  if (visited.size !== branches.length) throw new Error("Цикл родительских веток истории");
  // Снизу вверх по дереву: даже без нового checkpoint родитель остаётся стволом
  // над работой детей. Это геометрическая граница, не дополнительное событие.
  for (const branch of [...ordered].reverse()) {
    const range = ranges.get(branch.id);
    if (range === undefined || branch.parentSessionId === null) continue;
    if (!byId.has(branch.parentSessionId)) throw new Error("Нет родительской линии истории");
    include(branch.parentSessionId, range.first);
    include(branch.parentSessionId, range.last + 1);
  }
  /**
   * Выбирает ближайшую свободную дорожку справа от родителя без переноса старых точек.
   */
  const place = (branch: WorkGraphBranch): void => {
    const range = ranges.get(branch.id);
    const colorIndex = colors.get(branch.id);
    if (range === undefined || colorIndex === undefined) return;
    const isOpen = branch.status !== "completed" && branch.status !== "cancelled";
    const occupied = new Set<number>();
    for (const [id, lane] of lanes) {
      const other = byId.get(id);
      if (other === undefined) throw new Error("Нет владельца дорожки истории");
      const isOtherOpen = other.status !== "completed" && other.status !== "cancelled";
      const overlaps = lane.first <= range.last && range.first <= lane.last;
      const sharesOpenWork = isOpen && isOtherOpen && roots.get(id) === roots.get(branch.id);
      if (overlaps || sharesOpenWork) occupied.add(lane.column);
    }
    let column = (lanes.get(branch.parentSessionId ?? "")?.column ?? 0) + 1;
    while (occupied.has(column)) column += 1;
    lanes.set(branch.id, { column, colorIndex, ...range });
  };
  // Целое поддерево получает место раньше соседних поддеревьев: короткий ребёнок
  // остаётся рядом с родителем, а не уезжает за все ранее созданные корневые поручения.
  for (const branch of ordered) place(branch);
  const columns = new Map<number, Map<string, number>>();
  for (const row of [...rows].sort((a, b) => a - b)) {
    columns.set(
      row,
      new Map(
        [...lanes]
          .filter(([, lane]) => lane.first <= row && row <= lane.last)
          .map(([id, lane]) => [id, lane.column]),
      ),
    );
  }
  return { lanes, columns };
};
