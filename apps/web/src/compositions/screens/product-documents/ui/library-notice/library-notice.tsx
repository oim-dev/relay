import clsx from "clsx";
import { CloseButton } from "@mantine/core";
import { AlertTriangle, CircleAlert } from "lucide-react";
import { isDefined } from "shared/value-predicates";
import type { LibraryNoticeProps } from "./types/library-notice-props.type";
import styles from "./styles/library-notice.module.css";

/**
 * Сообщает об ошибке чтения или отказе быстрого действия рядом с выдачей, не скрывая её.
 *
 * Используется для:
 *  - конфликта ревизии, устаревшей выдачи и ошибок записи с действием восстановления
 */
export const LibraryNotice = (props: LibraryNoticeProps) => {
  const { tone, title, message, action, onDismiss, className, ...rootAttrs } = props;
  const Icon = tone === "danger" ? CircleAlert : AlertTriangle;
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)} data-tone={tone} role="alert">
      <Icon size={18} className={styles.icon} data-tone={tone} aria-hidden="true" />
      <div className={styles.body}>
        <p className={styles.title}>{title}</p>
        <p className={styles.message}>{message}</p>
        {action}
      </div>
      {isDefined(onDismiss) && (
        <CloseButton size="sm" aria-label="Скрыть сообщение" onClick={onDismiss} />
      )}
    </div>
  );
};
