import { GraphPoint } from "../graph-point/graph-point";
import { HistoryHandles } from "../history-handles/history-handles";
import type { HistoryPointProps } from "./types/history-point-props.type";

/**
 * Соединяет сохранённую авторскую карточку с нодой и портами React Flow.
 *
 * Используется для:
 *  - открытия точки и последовательной клавиатурной навигации без режима редактирования
 */
export const HistoryPoint = (props: HistoryPointProps) => {
  const { id, data } = props;
  const row = {
    point: data.point,
    branch: data.branch,
    run: data.run,
    color: data.color,
    x: data.anchorOffset.x,
    y: data.anchorOffset.y,
  };
  return (
    <>
      <HistoryHandles nodeId={id} ports={data.ports} />
      <GraphPoint
        row={row}
        isOpenEnd={data.isOpenEnd}
        isOutsidePage={data.isOutsidePage}
        isSelected={data.isSelected}
        isHighlighted={data.isHighlighted}
        onSelectPoint={data.onSelect}
        data-flow-marker-id={id}
        className="nodrag nopan"
        onFocus={() => data.onFocus(id)}
        onKeyDown={(event) => {
          const direction =
            event.key === "ArrowDown"
              ? "next"
              : event.key === "ArrowUp"
                ? "previous"
                : event.key === "Home"
                  ? "first"
                  : event.key === "End"
                    ? "last"
                    : undefined;
          if (direction === undefined) return;
          event.preventDefault();
          event.stopPropagation();
          data.onNavigate(id, direction);
        }}
      />
    </>
  );
};
