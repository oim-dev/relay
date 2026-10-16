import clsx from "clsx";
import { CircleDot, Hourglass, Pause } from "lucide-react";
import { isEmptyArray } from "shared/value-predicates";
import type { UnfinishedSessionsProps } from "./types/unfinished-sessions-props.type";
import styles from "./styles/unfinished-sessions.module.css";

/**
 * Показывает компактные адреса незавершённых веток над холстом.
 *
 * Используется для:
 *  - перехода к последней сохранённой точке без фильтрации истории
 */
export const UnfinishedSessions = (props: UnfinishedSessionsProps) => {
  const { items, onRevealPoint, className, ...rootAttrs } = props;
  const sessionItems = items.map((item) => ({
    ...item,
    Icon: item.status === "paused" ? Pause : item.status === "pending" ? Hourglass : CircleDot,
    statusLabel:
      item.status === "paused"
        ? "На паузе"
        : item.status === "pending"
          ? "Ожидает агента"
          : "Не завершено",
  }));
  if (isEmptyArray(sessionItems)) return null;
  return (
    <nav {...rootAttrs} className={clsx(styles.root, className)} aria-label="Незавершённые сессии">
      <span className={styles.heading}>
        Незавершённые <b>{sessionItems.length}</b>
      </span>
      <ul className={styles.list}>
        {sessionItems.map(({ pointId, title, statusLabel, color, Icon }) => (
          <li key={pointId} className={styles.item}>
            <button
              type="button"
              className={styles.link}
              style={{ borderInlineStartColor: color }}
              aria-label={`${title}. ${statusLabel}. Перейти к последней точке`}
              title={`${title} · ${statusLabel}`}
              onClick={() => onRevealPoint(pointId)}
            >
              <Icon size={14} aria-hidden="true" />
              <span className={styles.title}>{title}</span>
              <span className={styles.status}>{statusLabel}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
};
