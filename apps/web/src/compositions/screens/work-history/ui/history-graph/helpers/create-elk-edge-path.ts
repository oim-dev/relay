import type { XYPosition } from "@xyflow/react";
import type { HistoryEdgeGap } from "../types/history-flow.type";
import { HISTORY_EDGE_WIDTH } from "../config/history-elk.config";

/**
 * Скругляет только выданные ELK углы, сохраняя endpoints и коридор каждого section.
 * Радиус 8 ограничен половиной соседних сегментов; здесь нет поиска другого маршрута.
 */
const roundedSection = (raw: XYPosition[]): string => {
  const points = raw.filter((point, index) => {
    const previous = raw[index - 1];
    return (
      previous === undefined || Math.hypot(point.x - previous.x, point.y - previous.y) > 0.000001
    );
  });
  const first = points[0];
  if (first === undefined) return "";
  const commands = [`M ${first.x} ${first.y}`];
  for (let index = 1; index < points.length - 1; index += 1) {
    const a = points[index - 1],
      b = points[index],
      c = points[index + 1];
    if (a === undefined || b === undefined || c === undefined) continue;
    const ab = Math.hypot(b.x - a.x, b.y - a.y);
    const bc = Math.hypot(c.x - b.x, c.y - b.y);
    const turn = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(turn) < 0.000001) {
      commands.push(`L ${b.x} ${b.y}`);
      continue;
    }
    const radius = Math.min(8, ab / 2, bc / 2);
    const before = { x: b.x + ((a.x - b.x) * radius) / ab, y: b.y + ((a.y - b.y) * radius) / ab };
    const after = { x: b.x + ((c.x - b.x) * radius) / bc, y: b.y + ((c.y - b.y) * radius) / bc };
    commands.push(`L ${before.x} ${before.y}`, `Q ${b.x} ${b.y} ${after.x} ${after.y}`);
  }
  const last = points.at(-1);
  if (last !== undefined && last !== first) commands.push(`L ${last.x} ${last.y}`);
  return commands.join(" ");
};

/**
 * Оставляет короткие разрывы под пересекающей линией, сохраняя исходный маршрут и углы ELK.
 */
export const createElkEdgePath = (
  sections: XYPosition[][],
  gaps: HistoryEdgeGap[] = [],
  junction?: "start" | "end",
): string => {
  const parts: XYPosition[][] = [];
  for (const [section, points] of sections.entries()) {
    const first = points[0];
    if (first === undefined) continue;
    let current = [first];
    for (let segment = 1; segment < points.length; segment += 1) {
      const from = points[segment - 1];
      const to = points[segment];
      if (from === undefined || to === undefined) continue;
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      if (length < 0.000001) continue;
      const cuts = gaps
        .filter((gap) => gap.section === section && gap.segment === segment)
        .map((gap) => ({ start: gap.offset - gap.radius, end: gap.offset + gap.radius }))
        .sort((a, b) => a.start - b.start);
      let end = 0;
      for (const cut of cuts) {
        if (cut.end <= end) continue;
        if (cut.start > end) {
          current.push({
            x: from.x + ((to.x - from.x) * cut.start) / length,
            y: from.y + ((to.y - from.y) * cut.start) / length,
          });
          parts.push(current);
        }
        end = cut.end;
        current = [
          {
            x: from.x + ((to.x - from.x) * end) / length,
            y: from.y + ((to.y - from.y) * end) / length,
          },
        ];
      }
      current.push(to);
    }
    parts.push(current);
  }
  // Круглый торец выступает на половину толщины. У стыка укорачиваем только штрих,
  // чтобы сохранить единый пунктир и не закрасить родительскую дорожку под стрелкой.
  const junctionPart =
    junction === "start" ? parts[0] : junction === "end" ? parts.at(-1) : undefined;
  if (junctionPart !== undefined) {
    const index = junction === "start" ? 0 : junctionPart.length - 1;
    const endpoint = junctionPart[index];
    const neighbor = junctionPart[junction === "start" ? 1 : index - 1];
    if (endpoint !== undefined && neighbor !== undefined) {
      const length = Math.hypot(neighbor.x - endpoint.x, neighbor.y - endpoint.y);
      if (length > 0) {
        const inset = Math.min(HISTORY_EDGE_WIDTH / 2, length / 2);
        junctionPart[index] = {
          x: endpoint.x + ((neighbor.x - endpoint.x) * inset) / length,
          y: endpoint.y + ((neighbor.y - endpoint.y) * inset) / length,
        };
      }
    }
  }
  return parts.map(roundedSection).join(" ");
};

/**
 * Носитель единственной стрелки у настоящего конца ребра. Marker на всём path создал бы
 * лишние стрелки на каждом M-подпути, в том числе перед разрывами пересечений.
 */
export const createElkArrowPath = (sections: XYPosition[][]): string => {
  const section = sections.at(-1);
  const end = section?.at(-1);
  const previous = section?.at(-2);
  if (end === undefined || previous === undefined) return "";
  const length = Math.hypot(end.x - previous.x, end.y - previous.y);
  if (length < 0.000001) return "";
  const tail = Math.min(8, length);
  const x = end.x + ((previous.x - end.x) * tail) / length;
  const y = end.y + ((previous.y - end.y) * tail) / length;
  return `M ${x} ${y} L ${end.x} ${end.y}`;
};
