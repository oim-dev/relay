import { HistoryHandles } from "../history-handles/history-handles";
import type { HistoryDateProps } from "./types/history-date-props.type";
import styles from "./styles/history-date.module.css";

/**
 * Подписывает сохранённое время строки слева от оси проекта.
 *
 * Используется для:
 *  - календарных групп newest-first без пропорциональных времени пустот
 */
export const HistoryDate = (props: HistoryDateProps) => {
  const { id, data } = props;
  const hasDay = data.dayLabel !== "";
  return (
    <>
      <HistoryHandles nodeId={id} ports={data.ports} />
      <time className={styles.root} dateTime={data.at}>
        {hasDay && <strong>{data.dayLabel}</strong>}
        <span>{data.timeLabel}</span>
      </time>
    </>
  );
};
