import { Fragment, useEffect } from "react";
import { Handle, useUpdateNodeInternals } from "@xyflow/react";
import type { HistoryHandlesProps } from "./types/history-handles-props.type";
import styles from "./styles/history-handles.module.css";

/**
 * Согласует невидимые порты React Flow с рассчитанными ELK маршрутами.
 *
 * Используется для:
 *  - отображения read-only рёбер без скрытия технических нод через hidden
 */
export const HistoryHandles = (props: HistoryHandlesProps) => {
  const { nodeId, ports } = props;
  const update = useUpdateNodeInternals();
  const signature = ports
    .map((port) => `${port.id}:${port.position.x}:${port.position.y}`)
    .join("|");
  useEffect(() => {
    update(nodeId);
  }, [nodeId, signature, update]);
  return ports.map((port) => (
    <Fragment key={port.id}>
      <Handle
        id={port.id}
        type="source"
        position={port.side}
        isConnectable={false}
        className={styles.port}
        style={{
          left: port.position.x,
          top: port.position.y,
          right: "auto",
          bottom: "auto",
          width: 1,
          height: 1,
          minWidth: 0,
          minHeight: 0,
          transform: "translate(-50%, -50%)",
        }}
      />
      <Handle
        id={port.id}
        type="target"
        position={port.side}
        isConnectable={false}
        className={styles.port}
        style={{
          left: port.position.x,
          top: port.position.y,
          right: "auto",
          bottom: "auto",
          width: 1,
          height: 1,
          minWidth: 0,
          minHeight: 0,
          transform: "translate(-50%, -50%)",
        }}
      />
    </Fragment>
  ));
};
