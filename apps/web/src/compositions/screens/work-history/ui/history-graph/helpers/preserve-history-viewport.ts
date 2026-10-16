import type { Viewport, XYPosition } from "@xyflow/react";
import type { HistoryElkSnapshot, HistoryPlacedNode } from "../types/history-elk.type";

/**
 * Возвращает центр настоящего маркера в системе координат ELK.
 */
export const historyNodeCenter = (node: HistoryPlacedNode): XYPosition => ({
  x: node.position.x + node.width / 2,
  y: node.position.y + node.height / 2,
});

/**
 * Сохраняет текущий zoom и экранное положение первого видимого общего маркера. Меняется камера,
 * а не рассчитанные ELK ноды/routes; Modal не вызывает эту операцию без нового layout-среза.
 */
export const preserveHistoryViewport = (
  previous: HistoryElkSnapshot,
  next: HistoryElkSnapshot,
  viewport: Viewport,
  viewportHeight: number,
  focusedNodeId: string | null,
): Viewport => {
  const prefix = `${previous.projectId}:`;
  const focused = focusedNodeId?.startsWith(prefix)
    ? previous.nodes.get(focusedNodeId.slice(prefix.length))
    : undefined;
  const visible = previous.pointOrder
    .map((id) => previous.nodes.get(id))
    .filter((node): node is HistoryPlacedNode => {
      if (node === undefined || !next.nodes.has(node.id)) return false;
      const y = historyNodeCenter(node).y * viewport.zoom + viewport.y;
      return y >= 0 && y <= viewportHeight;
    });
  const anchor = focused !== undefined && next.nodes.has(focused.id) ? focused : visible[0];
  const successor = anchor === undefined ? undefined : next.nodes.get(anchor.id);
  if (anchor === undefined || successor === undefined) return viewport;
  const before = historyNodeCenter(anchor);
  const after = historyNodeCenter(successor);
  return {
    x: viewport.x + (before.x - after.x) * viewport.zoom,
    y: viewport.y + (before.y - after.y) * viewport.zoom,
    zoom: viewport.zoom,
  };
};
