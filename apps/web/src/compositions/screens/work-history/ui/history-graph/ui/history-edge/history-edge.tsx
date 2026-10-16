import { BaseEdge } from "@xyflow/react";
import { createElkArrowPath, createElkEdgePath } from "../../helpers/create-elk-edge-path";
import { HISTORY_EDGE_WIDTH } from "../../config/history-elk.config";
import type { HistoryEdgeProps } from "./types/history-edge-props.type";
import styles from "./styles/history-edge.module.css";

/**
 * Рисует BaseEdge по готовым sections ELK без собственного routing fallback.
 *
 * Используется для:
 *  - прямого ответвления и возврата стрелкой в родительскую дорожку
 *  - отображения пересечений без ложных соединений и дополнительных стрелок
 */
export const HistoryEdge = (props: HistoryEdgeProps) => {
  const { id, data, markerEnd } = props;
  if (data === undefined) return null;
  const isStart = data.kind === "fork" || data.kind === "root-start";
  const isEnd = data.kind === "branch-end" || data.kind === "root-end";
  const junction = isStart ? "start" : isEnd ? "end" : undefined;
  const path = createElkEdgePath(data.sections, data.gaps, junction);
  const dashArray = data.isWorker ? "5 5" : undefined;
  const arrowPath = createElkArrowPath(data.sections);
  const hasArrow = markerEnd !== undefined && arrowPath !== "";
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: data.color,
          strokeWidth: HISTORY_EDGE_WIDTH,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          fill: "none",
          strokeDasharray: dashArray,
        }}
        className={styles.root}
        interactionWidth={0}
        data-layout-engine="elk"
        data-edge-kind={data.kind}
        data-boundary={data.isBoundary}
        data-worker={data.isWorker}
        data-gap-count={data.gaps?.length ?? 0}
        data-route-sections={JSON.stringify(data.sections)}
      />
      {hasArrow && (
        <BaseEdge
          path={arrowPath}
          markerEnd={markerEnd}
          style={{ stroke: data.color, strokeWidth: HISTORY_EDGE_WIDTH }}
          className={styles.arrow}
          interactionWidth={0}
          data-arrow-for={id}
        />
      )}
    </>
  );
};
