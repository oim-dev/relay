import clsx from "clsx";
import { Button } from "@mantine/core";
import { RefreshCw } from "lucide-react";
import { isDefined } from "shared/value-predicates";
import type { SyncNoticeProps } from "./types/sync-notice-props.type";
import styles from "./styles/sync-notice.module.css";

/** Содержание предупреждения по причине устаревания. */
type NoticeContent = { tone: "warning" | "danger"; title: string; description: string };

const getNoticeContent = (
  props: Pick<SyncNoticeProps, "freshness" | "storageMessage" | "refreshError">,
): NoticeContent | null => {
  if (props.freshness === "storage-error")
    return {
      tone: "danger",
      title: "Ошибка хранилища проекта",
      description: `${props.storageMessage ?? "Проверьте конфигурацию и документы проекта."} Показаны последние успешно прочитанные данные.`,
    };
  if (isDefined(props.refreshError))
    return {
      tone: "danger",
      title: "Не удалось обновить обзор",
      description: `${props.refreshError} Показаны последние успешно прочитанные данные.`,
    };
  if (props.freshness === "offline")
    return {
      tone: "warning",
      title: "Нет связи с сервером обновлений",
      description:
        "Показаны данные на момент среза; изменения появятся после восстановления соединения.",
    };
  return null;
};

/**
 * Предупреждает, что показанный обзор может быть устаревшим, и предлагает повторить чтение.
 *
 * Используется для:
 *  - отказа потока изменений, ошибки хранилища и неудачного обновления
 */
export const SyncNotice = (props: SyncNoticeProps) => {
  const { freshness, storageMessage, refreshError, isRetrying, onRetry, className, ...rootAttrs } =
    props;
  const content = getNoticeContent({ freshness, storageMessage, refreshError });
  if (!isDefined(content)) return null;
  return (
    <div
      {...rootAttrs}
      className={clsx(styles.root, className)}
      data-tone={content.tone}
      role="alert"
    >
      <div className={styles.text}>
        <p className={styles.title}>{content.title}</p>
        <p className={styles.description}>{content.description}</p>
      </div>
      <Button
        variant="default"
        size="xs"
        loading={isRetrying}
        leftSection={<RefreshCw size={14} aria-hidden="true" />}
        onClick={onRetry}
      >
        Повторить чтение
      </Button>
    </div>
  );
};
