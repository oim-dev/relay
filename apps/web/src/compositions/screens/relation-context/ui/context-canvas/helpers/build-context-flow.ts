import { MarkerType } from "@xyflow/react";
import { getRelationLabel, relationAddress } from "domains/relations";
import { isDefined, isNonEmptyArray } from "shared/value-predicates";
import { CONTEXT_NODE_SIZE } from "../config/context-canvas.config";
import type { ContextCanvasParams } from "../types/context-canvas-props.type";
import type { ContextFlowNode, ContextFlowEdge } from "../types/context-flow.type";
import type { ContextLayout } from "../types/context-layout.type";

/**
 * Применяет согласованную геометрию и выделение, сохраняя каждый ID и направление Core.
 */
export const buildContextFlow = (
  props: ContextCanvasParams,
  layout: ContextLayout,
  hoveredEdgeId: string | null,
) => {
  const pathIds = new Set(props.pathEdgeIds);
  const focusIds = new Set<string>([props.root]);
  let pathNodeId = props.selectedNodeId;
  while (pathNodeId !== null) {
    focusIds.add(pathNodeId);
    const parent = layout.parents.get(pathNodeId);
    if (!parent) break;
    if (!isNonEmptyArray(props.pathEdgeIds)) pathIds.add(parent.edgeId);
    pathNodeId = parent.nodeId;
  }
  const hasFocus =
    (props.selectedNodeId !== null && props.selectedNodeId !== props.root) ||
    props.selectedEdgeId !== null ||
    hoveredEdgeId !== null;
  const treeEdgeIds = new Set([...layout.parents.values()].map((parent) => parent.edgeId));
  const additionalById = new Map<string, number>();
  const loopsById = new Map<string, number>();
  for (const edge of props.edges) {
    const from = relationAddress(edge.from),
      to = relationAddress(edge.to);
    if (!treeEdgeIds.has(edge.id)) {
      for (const id of new Set([from, to]))
        additionalById.set(id, (additionalById.get(id) ?? 0) + 1);
    }
    if (from === to) loopsById.set(from, (loopsById.get(from) ?? 0) + 1);
    if (
      from === props.selectedNodeId ||
      to === props.selectedNodeId ||
      edge.id === props.selectedEdgeId ||
      edge.id === hoveredEdgeId ||
      pathIds.has(edge.id)
    ) {
      focusIds.add(from);
      focusIds.add(to);
    }
  }
  const nodes: ContextFlowNode[] = props.nodes.flatMap((entity) => {
    const id = relationAddress(entity.ref);
    const geometry = layout.nodes.get(id);
    if (!isDefined(geometry)) return [];
    const isDimmed = props.view === "graph" && hasFocus && !focusIds.has(id);
    const additionalCount = props.view === "tree" ? (additionalById.get(id) ?? 0) : 0;
    const loopCount = props.view === "tree" ? (loopsById.get(id) ?? 0) : 0;
    return [
      {
        id,
        type: "context",
        position: geometry.position,
        ...CONTEXT_NODE_SIZE,
        selected: props.selectedNodeId === id,
        deletable: false,
        ariaLabel: `${entity.key}: ${entity.title}. Дополнительных связей: ${additionalCount}`,
        data: {
          entity,
          isRoot: id === props.root,
          isBoundary: props.boundaryIds.includes(id),
          ports: geometry.ports,
          distance: layout.distances.get(id) ?? null,
          isDimmed,
          additionalCount,
          loopCount,
        },
      },
    ];
  });
  const edges: ContextFlowEdge[] = props.edges.flatMap((edge) => {
    const source = relationAddress(edge.from),
      target = relationAddress(edge.to);
    const route = layout.edges.get(edge.id),
      fromNode = layout.nodes.get(source),
      toNode = layout.nodes.get(target);
    if (!route || !fromNode || !toNode) return [];
    const isSelected = props.selectedEdgeId === edge.id;
    const isHovered = hoveredEdgeId === edge.id;
    const isIncident = props.selectedNodeId === source || props.selectedNodeId === target;
    const isOnPath = pathIds.has(edge.id);
    const isImportant = isSelected || isHovered || isOnPath || isIncident;
    const isTreeEdge = treeEdgeIds.has(edge.id);
    // Выбранная линия и путь — основной текст, линии выбранной сущности — акцент, как в легенде.
    const color =
      isOnPath || isSelected || isHovered
        ? "var(--tasks-ink)"
        : isIncident
          ? "var(--tasks-accent)"
          : "var(--tasks-soft)";
    const fromLabel =
      props.nodes.find((node) => relationAddress(node.ref) === source)?.key ?? source;
    const toLabel = props.nodes.find((node) => relationAddress(node.ref) === target)?.key ?? target;
    const hasManualPosition =
      fromNode.position.x !== fromNode.origin.x ||
      fromNode.position.y !== fromNode.origin.y ||
      toNode.position.x !== toNode.origin.x ||
      toNode.position.y !== toNode.origin.y;
    return [
      {
        id: edge.id,
        source,
        target,
        type: "context",
        selected: isSelected,
        sourceHandle: route.sourcePortId,
        targetHandle: route.targetPortId,
        deletable: false,
        reconnectable: false,
        focusable: true,
        ariaLabel: `${getRelationLabel(edge.type)}: ${fromLabel} → ${toLabel}`,
        markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color },
        style: {
          stroke: color,
          strokeWidth: isImportant ? 2 : isTreeEdge ? 1.5 : 1,
          opacity:
            hasFocus && !isImportant && props.view === "graph" ? 0.16 : isImportant ? 1 : 0.7,
        },
        zIndex: isImportant ? 2 : 0,
        data: {
          points: route.points,
          labelPosition: route.labelPosition,
          hasManualPosition,
          hasLabel: isSelected || isHovered || isOnPath || (props.edges.length <= 12 && isIncident),
          title: getRelationLabel(edge.type),
        },
      },
    ];
  });
  return { nodes, edges };
};
