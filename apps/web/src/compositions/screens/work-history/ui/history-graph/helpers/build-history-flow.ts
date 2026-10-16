import type { HistoryGraphParams } from "../types/history-graph-props.type";
import type { HistoryElkSnapshot } from "../types/history-elk.type";
import type { HistoryFlowNode } from "../types/history-flow.type";

/** Дополнительные действия read-only камеры. */
export type HistoryFlowActions = {
  /** Видимость вручную выбранного маркера. */
  onFocus: (nodeId: string) => void;
  /** Хронологическая клавиатурная навигация. */
  onNavigate: (nodeId: string, direction: "next" | "previous" | "first" | "last") => void;
};

/**
 * Связывает семантику и позиции готового ELK-среза с React Flow. Позиции и routes не пересчитываются.
 * Технические anchors остаются настоящими RF-нодами без hidden=true, чтобы не исчезали рёбра.
 */
export const buildHistoryFlow = (
  snapshot: HistoryElkSnapshot | null,
  props: HistoryGraphParams,
  actions: HistoryFlowActions,
  revealedPoint: string | null,
): HistoryFlowNode[] => {
  if (snapshot === null) return [];
  const nodes: HistoryFlowNode[] = [];
  for (const node of snapshot.nodes.values()) {
    const { marker } = node;
    const base = {
      id: `${snapshot.projectId}:${node.id}`,
      position: node.position,
      width: Math.max(1, node.width),
      height: Math.max(1, node.height),
      style: {
        width: Math.max(1, node.width),
        height: Math.max(1, node.height),
        background: "transparent",
        border: 0,
        padding: 0,
      },
      draggable: false,
      selectable: false,
      connectable: false,
      focusable: false,
    };
    if (marker.kind === "point") {
      nodes.push({
        ...base,
        type: "historyPoint",
        data: {
          point: marker.point,
          branch: marker.branch,
          run: marker.run,
          color: marker.color,
          ports: node.ports,
          anchorOffset: { x: node.width / 2, y: node.height / 2 },
          isOpenEnd: marker.isOpenEnd,
          isOutsidePage: marker.isOutsidePage,
          isSelected:
            props.selectedPoint === null
              ? revealedPoint === marker.point.id
              : props.selectedPoint === marker.point.id ||
                props.selectedPoint === marker.point.checkpointId,
          isHighlighted:
            props.highlightedSession === marker.branch.id ||
            props.highlightedSession === marker.branch.key,
          onSelect: props.onSelectPoint,
          ...actions,
        },
      });
    } else if (marker.kind === "boundary") {
      nodes.push({
        ...base,
        type: "historyBoundary",
        data: {
          boundary: marker.boundary,
          branch: marker.branch,
          color: marker.color,
          ports: node.ports,
          anchorOffset: { x: node.width / 2, y: node.height / 2 },
          onSelect: props.onSelectPoint,
          onFocus: actions.onFocus,
        },
      });
    } else if (marker.kind === "date") {
      nodes.push({
        ...base,
        type: "historyDate",
        ariaRole: "presentation",
        data: {
          at: marker.at,
          dayLabel: marker.dayLabel,
          timeLabel: marker.timeLabel,
          ports: node.ports,
        },
      });
    } else {
      nodes.push({
        ...base,
        type: "historyAnchor",
        ariaRole: "presentation",
        data: { ports: node.ports },
      });
    }
  }
  return nodes;
};
