import { MarkerType, Position } from "@xyflow/react";
import type { ElkNode, ElkExtendedEdge } from "elkjs/lib/elk-api";
import type { WorkGraph } from "domains/work-history";
import type {
  HistoryElkPlan,
  HistoryElkSnapshot,
  HistoryPlacedNode,
} from "../types/history-elk.type";
import type { HistoryFlowEdge, HistoryPort } from "../types/history-flow.type";
import { markHistoryCrossings } from "./mark-history-crossings";
import { clipHistoryJunctions } from "./clip-history-junctions";
import { HISTORY_EDGE_WIDTH } from "../config/history-elk.config";

/**
 * Переводит сторону порта ELK в технический контракт React Flow, не меняя координат.
 */
const portSide = (side: string | undefined): Position => {
  if (side === "WEST") return Position.Left;
  if (side === "EAST") return Position.Right;
  if (side === "SOUTH") return Position.Bottom;
  return Position.Top;
};

/**
 * Читает фактические позиции и sections ELK. Вложенные контейнеры имеют единый перенос
 * для своих нод и routes; содержание точек показывается локальными подсказками.
 */
export const readHistoryElk = (
  result: ElkNode,
  plan: HistoryElkPlan,
  graph: WorkGraph,
  projectId: string,
): HistoryElkSnapshot => {
  const nodes = new Map<string, HistoryPlacedNode>();
  const portOwners = new Map<string, string>();
  const routed: { edge: ElkExtendedEdge; x: number; y: number }[] = [];
  /**
   * Переносит вложенную систему координат одинаково для геометрии узлов и рёбер.
   */
  const visit = (container: ElkNode, x: number, y: number): void => {
    for (const edge of container.edges ?? []) routed.push({ edge, x, y });
    for (const node of container.children ?? []) {
      if (
        typeof node.x !== "number" ||
        typeof node.y !== "number" ||
        !Number.isFinite(node.x) ||
        !Number.isFinite(node.y)
      )
        throw new Error(`ELK не вернул позицию ${node.id}`);
      const position = { x: x + node.x, y: y + node.y };
      const ports: HistoryPort[] = (node.ports ?? []).map((port) => {
        if (typeof port.x !== "number" || typeof port.y !== "number")
          throw new Error(`ELK не вернул координаты порта ${port.id}`);
        portOwners.set(port.id, node.id);
        return {
          id: port.id,
          side: portSide(
            port.layoutOptions?.["elk.port.side"] ??
              port.layoutOptions?.["org.eclipse.elk.port.side"],
          ),
          position: { x: port.x + (port.width ?? 0) / 2, y: port.y + (port.height ?? 0) / 2 },
        };
      });
      nodes.set(node.id, {
        id: node.id,
        position,
        width: node.width ?? 1,
        height: node.height ?? 1,
        ports,
        marker: plan.markers.get(node.id) ?? { kind: "anchor" },
      });
      visit(node, position.x, position.y);
    }
  };
  visit(result, 0, 0);
  let previousY = -Infinity;
  for (const id of plan.pointOrder) {
    const point = nodes.get(id);
    const axis = nodes.get(`axis:${id}`);
    if (point === undefined || axis === undefined)
      throw new Error("ELK потерял точку хронологии или её ось");
    const pointY = point.position.y + point.height / 2;
    const axisY = axis.position.y + axis.height / 2;
    if (Math.abs(pointY - axisY) > 0.5 || pointY <= previousY)
      throw new Error(`ELK нарушил порядок/выравнивание строки ${id}`);
    previousY = pointY;
  }
  const edges: HistoryFlowEdge[] = [];
  const endpointIds = new Set<string>();
  let right = Math.max(
    result.width ?? 0,
    ...[...nodes.values()].map((node) => node.position.x + node.width),
  );
  let bottom = Math.max(0, ...[...nodes.values()].map((node) => node.position.y + node.height));
  for (const { edge, x, y } of routed) {
    const metadata = plan.edges.get(edge.id);
    if (metadata === undefined) continue;
    const sourcePort = edge.sources[0];
    const targetPort = edge.targets[0];
    const source = sourcePort === undefined ? undefined : portOwners.get(sourcePort);
    const target = targetPort === undefined ? undefined : portOwners.get(targetPort);
    if (source === undefined || target === undefined)
      throw new Error(`ELK не согласовал порты ${edge.id}`);
    const rawSections = (edge.sections ?? []).map((section) =>
      [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((point) => ({
        x: point.x + x,
        y: point.y + y,
      })),
    );
    const sections = clipHistoryJunctions(rawSections, metadata.kind);
    if (!sections.some((section) => section[1] !== undefined))
      throw new Error(`ELK не вернул маршрут ${edge.id}`);
    const all = sections.flat();
    const ys = all.map((point) => point.y);
    const span = Math.max(...ys) - Math.min(...ys);
    const isConnector =
      metadata.kind === "fork" ||
      metadata.kind === "branch-end" ||
      metadata.kind === "root-start" ||
      metadata.kind === "root-end";
    if (isConnector && span > plan.maxConnectorSpan)
      throw new Error(
        `ELK: соединение ${edge.id} вышло за полосу события (${Math.round(span)} px)`,
      );
    const xs = all.map((point) => point.x);
    const sourceNode = nodes.get(source);
    const targetNode = nodes.get(target);
    const sourceX = (sourceNode?.position.x ?? 0) + (sourceNode?.width ?? 0) / 2;
    const targetX = (targetNode?.position.x ?? 0) + (targetNode?.width ?? 0) / 2;
    const isStart = metadata.kind === "fork" || metadata.kind === "root-start";
    const hasBranchSeparation = isStart ? targetX > sourceX + 0.5 : sourceX > targetX + 0.5;
    if (isConnector && !hasBranchSeparation)
      throw new Error(`ELK совместил родительскую и дочернюю линии ${edge.id}`);
    if (isConnector) {
      const lastSection = sections.at(-1);
      const junction = isStart ? sections[0]?.[0] : lastSection?.at(-1);
      const neighbor = isStart ? sections[0]?.[1] : lastSection?.at(-2);
      const parentX = (isStart ? sourceX : targetX) + HISTORY_EDGE_WIDTH / 2;
      if (
        junction === undefined ||
        neighbor === undefined ||
        Math.abs(junction.x - parentX) > 0.5 ||
        Math.abs(junction.y - neighbor.y) > 0.5 ||
        neighbor.x <= junction.x
      )
        throw new Error(`ELK не согласовал горизонтальный стык с родителем ${edge.id}`);
    }
    if (!isConnector && Math.max(...xs) - Math.min(...xs) > 0.5)
      throw new Error(`ELK отклонил вертикальный ствол ${edge.id}`);
    for (const section of sections)
      for (let index = 1; index < section.length; index += 1) {
        const previous = section[index - 1];
        const current = section[index];
        if (previous === undefined || current === undefined) continue;
        if (Math.abs(previous.x - current.x) > 0.5 && Math.abs(previous.y - current.y) > 0.5)
          throw new Error(`ELK вернул неортогональный маршрут ${edge.id}`);
      }
    right = Math.max(right, ...all.map((point) => point.x));
    bottom = Math.max(bottom, ...ys);
    endpointIds.add(source);
    endpointIds.add(target);
    const isBranchEnd = metadata.kind === "branch-end" || metadata.kind === "root-end";
    edges.push({
      id: `${projectId}:${edge.id}`,
      type: "historyEdge",
      source: `${projectId}:${source}`,
      target: `${projectId}:${target}`,
      sourceHandle: sourcePort,
      targetHandle: targetPort,
      selectable: false,
      focusable: false,
      markerEnd: isBranchEnd
        ? {
            type: MarkerType.ArrowClosed,
            color: metadata.color,
            width: 24,
            height: 24,
            markerUnits: "userSpaceOnUse",
            strokeWidth: 0,
          }
        : undefined,
      data: { sections, ...metadata },
    });
  }
  for (const id of nodes.keys())
    if (!plan.markers.has(id) && !endpointIds.has(id)) nodes.delete(id);
  return {
    projectId,
    graph,
    nodes,
    edges: markHistoryCrossings(edges),
    pointOrder: plan.pointOrder,
    width: right + 24,
    height: bottom,
  };
};
