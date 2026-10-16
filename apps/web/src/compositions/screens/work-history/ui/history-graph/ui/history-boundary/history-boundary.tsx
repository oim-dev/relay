import type { CSSProperties } from "react";
import { Tooltip } from "@mantine/core";
import { ArrowDown, ArrowUp, ExternalLink } from "lucide-react";
import { formatWorkTime } from "domains/work-history";
import { HistoryHandles } from "../history-handles/history-handles";
import type { HistoryBoundaryProps } from "./types/history-boundary-props.type";
import styles from "./styles/history-boundary.module.css";

/**
 * Обозначает незагруженный endpoint, не превращая его в новый корень или завершение.
 *
 * Используется для:
 *  - адресного чтения полного материала за пределами текущих страниц
 */
export const HistoryBoundary = (props: HistoryBoundaryProps) => {
  const { id, data } = props;
  const label =
    data.boundary.side === "before"
      ? "Новее загруженного окна"
      : data.boundary.side === "after"
        ? "Ранее загруженного окна"
        : "За областью просмотра";
  const Icon =
    data.boundary.side === "before"
      ? ArrowUp
      : data.boundary.side === "after"
        ? ArrowDown
        : ExternalLink;
  const timeLabel = formatWorkTime(data.boundary.at);
  const description = `${label}. ${data.branch.title}. ${timeLabel}. Открыть точку отдельно.`;
  const style: CSSProperties & { "--graph-color": string } = {
    left: data.anchorOffset.x - 22,
    top: data.anchorOffset.y - 22,
    "--graph-color": data.color,
  };
  return (
    <>
      <HistoryHandles nodeId={id} ports={data.ports} />
      <Tooltip
        label={description}
        multiline
        withinPortal
        events={{ hover: true, focus: true, touch: false }}
        classNames={{ tooltip: styles.tooltip }}
      >
        <button
          type="button"
          className={`${styles.root} nodrag nopan`}
          style={style}
          aria-label={description}
          data-boundary-point={data.boundary.id}
          data-flow-marker-id={id}
          onFocus={() => data.onFocus(id)}
          onClick={(event) => data.onSelect(data.boundary.id, event.currentTarget)}
        >
          <span className={styles.marker}>
            <Icon size={16} aria-hidden="true" />
          </span>
        </button>
      </Tooltip>
    </>
  );
};
