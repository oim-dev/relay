import { BaseEdge, getSmoothStepPath } from "@xyflow/react";
import { createContextEdgePath } from "../../helpers/create-context-edge-path";
import type { ContextEdgeProps } from "./types/context-edge-props.type";
import styles from "./styles/context-edge.module.css";

/**
 * Рисует маршрут, рассчитанный ELK вместе с карточками и портами.
 *
 * Используется для:
 *  - сохранения отдельных линий параллельных связей и циклов
 */
export const ContextEdge = (props: ContextEdgeProps) => {
  const { id, markerEnd, style, data } = props;
  if (!data) return null;
  let path = createContextEdgePath(data.points);
  let { x: labelX, y: labelY } = data.labelPosition;
  if (data.hasManualPosition) {
    [path, labelX, labelY] = getSmoothStepPath({ ...props, borderRadius: 8, offset: 35 });
  }
  const label = data?.hasLabel ? data.title : undefined;
  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={style}
      interactionWidth={14}
      label={label}
      labelX={labelX}
      labelY={labelY}
      labelStyle={{ fill: "var(--tasks-muted)", fontSize: "var(--mantine-font-size-xs)" }}
      labelBgStyle={{ fill: "var(--tasks-surface)", fillOpacity: 0.96 }}
      labelBgPadding={[7, 5]}
      labelBgBorderRadius={5}
      className={styles.root}
    />
  );
};
