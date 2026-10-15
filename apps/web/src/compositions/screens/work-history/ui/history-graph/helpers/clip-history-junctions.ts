import type { XYPosition } from "@xyflow/react";
import type { HistoryFlowEdge } from "../types/history-flow.type";
import { HISTORY_EDGE_WIDTH } from "../config/history-elk.config";

/**
 * Убирает только концевой участок соединения, совпадающий с родительским стволом.
 * Оставшийся маршрут целиком принадлежит ELK: fork начинается горизонтально от линии,
 * join заканчивается горизонтально в ней, без цветного наложения на родительский ствол.
 */
export const clipHistoryJunctions = (
  sections: XYPosition[][],
  kind: NonNullable<HistoryFlowEdge["data"]>["kind"],
): XYPosition[][] => {
  const isStart = kind === "fork" || kind === "root-start";
  const isEnd = kind === "branch-end" || kind === "root-end";
  if (!isStart && !isEnd) return sections;
  return sections.map((points, section) => {
    let first = 0;
    let last = points.length - 1;
    if (isStart && section === 0) {
      while (first + 1 < last) {
        const start = points[first];
        const next = points[first + 1];
        if (start === undefined || next === undefined || Math.abs(start.x - next.x) > 0.5) break;
        first += 1;
      }
    }
    if (isEnd && section === sections.length - 1) {
      while (last - 1 > first) {
        const end = points[last];
        const previous = points[last - 1];
        if (end === undefined || previous === undefined || Math.abs(end.x - previous.x) > 0.5)
          break;
        last -= 1;
      }
    }
    const clipped = points.slice(first, last + 1);
    const junctionIndex = isStart ? 0 : clipped.length - 1;
    const junction = clipped[junctionIndex];
    const isJunctionSection = isStart ? section === 0 : section === sections.length - 1;
    if (isJunctionSection && junction !== undefined)
      clipped[junctionIndex] = { ...junction, x: junction.x + HISTORY_EDGE_WIDTH / 2 };
    return clipped;
  });
};
