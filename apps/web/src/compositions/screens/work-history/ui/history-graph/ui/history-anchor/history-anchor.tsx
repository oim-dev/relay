import { HistoryHandles } from "../history-handles/history-handles";
import type { HistoryAnchorProps } from "./types/history-anchor-props.type";

/**
 * Сохраняет технические endpoints видимыми для движка, но невидимыми для человека.
 *
 * Используется для:
 *  - подключения рёбер к оси и родительской линии без новых предметных событий
 */
export const HistoryAnchor = (props: HistoryAnchorProps) => {
  return <HistoryHandles nodeId={props.id} ports={props.data.ports} />;
};
