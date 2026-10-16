import type { ElkNode, ElkExtendedEdge } from "elkjs/lib/elk-api";
import type { WorkGraph } from "domains/work-history";
import { HISTORY_ELK_OPTIONS, HISTORY_LANE_HINT_PITCH } from "../config/history-elk.config";
import { assignHistoryLanes } from "./assign-history-lanes";
import { buildVisualOrdinals, compareVisualText } from "./build-visual-ordinals";
import type { HistoryElkPlan, HistoryMarker, HistoryEdgeMetadata } from "../types/history-elk.type";

/** Внутренний узел ограничения, не дополнительное событие Relay. */
type PlanNode = {
  /** Входная фигура ELK с портами. */
  node: ElkNode;
  /** Владелец линии или axis. */
  lane: string;
  /** Визуальная подстрока реального события. */
  partition: number;
};

/**
 * Строит проверенную ELK-задачу: axis + реальные points + минимальные parent anchors.
 * x/y являются подсказками interactive phases; все итоговые позиции и routes читает ELK-reader.
 */
export const createHistoryElkPlan = (graph: WorkGraph): HistoryElkPlan => {
  const branches = new Map(graph.branches.map((branch) => [branch.id, branch]));
  const runs = new Map(graph.runs.map((run) => [run.id, run]));
  const visible = new Map(graph.items.map((point) => [point.id, point]));
  const openEnds = new Map(graph.openEnds.map((point) => [point.id, point]));
  const boundaries = new Map(graph.boundaryNodes.map((point) => [point.id, point]));
  const all = buildVisualOrdinals(graph).points;
  const byId = new Map(all.map((point) => [point.id, point]));
  const partitions = new Map(all.map((point, index) => [point.id, index * 3 + 1]));
  const { lanes, columns } = assignHistoryLanes(graph, partitions);
  const rowCount = Math.max(0, ...columns.keys()) + 1;
  const markers = new Map<string, HistoryMarker>();
  const edgeMetadata = new Map<string, HistoryEdgeMetadata>();
  const children: PlanNode[] = [];
  const edges: ElkExtendedEdge[] = [];
  const laneNodes = new Map<string, PlanNode[]>();
  /**
   * Находит роль цвета без привязки к переиспользованной колонке.
   */
  const colorFor = (lane: string): string =>
    lane === "axis"
      ? "var(--tasks-history-axis)"
      : `var(--tasks-history-lane-${(lanes.get(lane)?.colorIndex ?? 0) + 1})`;
  /**
   * Добавляет узел с фиксированными сторонами портов и временным partition.
   */
  const addNode = (
    id: string,
    lane: string,
    partition: number,
    marker: HistoryMarker,
    size: number,
  ): PlanNode => {
    const laneIndex = lane === "axis" ? 0 : columns.get(partition)?.get(lane);
    if (laneIndex === undefined) throw new Error(`Нет колонки ветки ${lane}`);
    const node: ElkNode = {
      id,
      width: size,
      height: size,
      x: 20 + laneIndex * HISTORY_LANE_HINT_PITCH - size / 2,
      y: 20 + (rowCount - partition) * 100 - size / 2,
      layoutOptions: {
        // Изолированная старая openEnd-точка выравнивается с осью по центру, как связанная.
        "org.eclipse.elk.alignment": "CENTER",
        "org.eclipse.elk.portConstraints": "FIXED_POS",
        "org.eclipse.elk.partitioning.partition": String(partition),
      },
      ports: ["NORTH", "SOUTH", "EAST", "WEST"].map((side) => ({
        id: `${id}@${side}`,
        width: 0,
        height: 0,
        x: side === "WEST" ? 0 : side === "EAST" ? size : size / 2,
        y: side === "NORTH" ? 0 : side === "SOUTH" ? size : size / 2,
        layoutOptions: {
          "org.eclipse.elk.port.side": side,
          "org.eclipse.elk.layered.allowNonFlowPortsToSwitchSides": "false",
        },
      })),
    };
    const entry = { node, lane, partition };
    children.push(entry);
    const entries = laneNodes.get(lane) ?? [];
    entries.push(entry);
    laneNodes.set(lane, entries);
    markers.set(id, marker);
    return entry;
  };
  /**
   * Передаёт соединение настоящему роутеру ELK, не создавая готовых sections вручную.
   */
  const addEdge = (
    id: string,
    source: string,
    target: string,
    metadata: HistoryEdgeMetadata,
    sourceSide = "NORTH",
    targetSide = "SOUTH",
  ): void => {
    const isStraight = metadata.kind === "sequence" || metadata.kind === "axis";
    edges.push({
      id,
      sources: [`${source}@${sourceSide}`],
      targets: [`${target}@${targetSide}`],
      layoutOptions: { "org.eclipse.elk.layered.priority.straightness": isStraight ? "1000" : "1" },
    });
    edgeMetadata.set(id, metadata);
  };
  for (const point of all) {
    const partition = partitions.get(point.id);
    const branch = branches.get(point.sessionId);
    if (partition === undefined || branch === undefined)
      throw new Error("Неполный контекст точки истории");
    const full = visible.get(point.id) ?? openEnds.get(point.id);
    const boundary = boundaries.get(point.id);
    let marker: HistoryMarker = { kind: "anchor" };
    if (full !== undefined)
      marker = {
        kind: "point",
        point: full,
        branch,
        run: runs.get(full.runId ?? "") ?? null,
        color: colorFor(branch.id),
        isOpenEnd: openEnds.has(point.id),
        isOutsidePage: !visible.has(point.id),
      };
    else if (boundary !== undefined)
      marker = { kind: "boundary", boundary, branch, color: colorFor(branch.id) };
    addNode(point.id, point.sessionId, partition, marker, full === undefined ? 8 : 40);
    addNode(`axis:${point.id}`, "axis", partition, { kind: "anchor" }, 2);
  }
  const pointOrder = [...all]
    .reverse()
    .filter((point) => visible.has(point.id) || openEnds.has(point.id))
    .map((point) => point.id);
  let lastDay = "";
  for (const id of pointOrder) {
    const point = visible.get(id) ?? openEnds.get(id);
    if (point === undefined) continue;
    const date = new Date(point.at);
    const day = date.toLocaleDateString("ru-RU");
    markers.set(`axis:${id}`, {
      kind: "date",
      at: point.at,
      dayLabel:
        day === lastDay
          ? ""
          : `${date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}\n${date.getFullYear()}`,
      timeLabel: date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
    });
    lastDay = day;
  }
  addNode("axis:head", "axis", rowCount, { kind: "anchor" }, 2);
  for (const edge of [...graph.edges].sort((a, b) =>
    compareVisualText(JSON.stringify(a), JSON.stringify(b)),
  )) {
    if (edge.kind === "sequence") continue;
    const isStart = edge.kind === "fork" || edge.kind === "root-start";
    const pointId = isStart ? edge.to : edge.from;
    const point = byId.get(pointId);
    const partition = partitions.get(pointId);
    if (point === undefined || partition === undefined)
      throw new Error("Нет реальной точки для fork/join");
    const parent =
      edge.kind === "fork"
        ? edge.fromSessionId
        : edge.kind === "branch-end"
          ? edge.toSessionId
          : "axis";
    const anchorId = `anchor:${edge.kind}:${point.id}:${parent}`;
    addNode(anchorId, parent, partition + (isStart ? -1 : 1), { kind: "anchor" }, 2);
    const source = isStart ? anchorId : point.id;
    const target = isStart ? point.id : anchorId;
    const branch = branches.get(point.sessionId);
    addEdge(
      `topology:${edge.kind}:${point.id}`,
      source,
      target,
      {
        kind: edge.kind,
        color: colorFor(point.sessionId),
        isBoundary: false,
        isWorker: edge.kind === "fork" || edge.kind === "branch-end",
        isUnfinished:
          branch?.status === "open" || branch?.status === "paused" || branch?.status === "pending",
      },
      "NORTH",
      "SOUTH",
    );
  }
  for (const [lane, range] of lanes) {
    for (const partition of [range.first, range.last]) {
      if (laneNodes.get(lane)?.some((node) => node.partition === partition)) continue;
      addNode(`extent:${lane}:${partition}`, lane, partition, { kind: "anchor" }, 2);
    }
  }
  const firstAxis = (laneNodes.get("axis") ?? []).reduce<PlanNode | undefined>(
    (first, node) => (first === undefined || node.partition < first.partition ? node : first),
    undefined,
  );
  const earliest = children.reduce<PlanNode | undefined>(
    (first, node) => (first === undefined || node.partition < first.partition ? node : first),
    undefined,
  );
  if (firstAxis !== undefined && earliest !== undefined && earliest.partition < firstAxis.partition)
    addNode(`axis:extent:${earliest.node.id}`, "axis", earliest.partition, { kind: "anchor" }, 2);
  for (const [lane, entries] of laneNodes) {
    const branch = branches.get(lane);
    const sorted = entries.sort(
      (a, b) => a.partition - b.partition || a.node.id.localeCompare(b.node.id),
    );
    for (let index = 1; index < sorted.length; index += 1) {
      const source = sorted[index - 1];
      const target = sorted[index];
      if (source === undefined || target === undefined) continue;
      addEdge(`line:${lane}:${source.node.id}:${target.node.id}`, source.node.id, target.node.id, {
        kind: lane === "axis" ? "axis" : "sequence",
        color: colorFor(lane),
        isBoundary: boundaries.has(source.node.id) || boundaries.has(target.node.id),
        isWorker: branch !== undefined && branch.parentSessionId !== null,
        isUnfinished:
          branch?.status === "open" || branch?.status === "paused" || branch?.status === "pending",
      });
    }
  }
  children.sort(
    (a, b) =>
      a.partition - b.partition ||
      (a.node.x ?? 0) - (b.node.x ?? 0) ||
      compareVisualText(a.node.id, b.node.id),
  );
  return {
    graph: {
      id: "history",
      layoutOptions: { ...HISTORY_ELK_OPTIONS },
      children: children.map((entry) => entry.node),
      edges,
    },
    markers,
    edges: edgeMetadata,
    pointOrder,
    maxConnectorSpan: 64,
  };
};
