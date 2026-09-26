import clsx from "clsx";
import { useId } from "react";
import { Button, Skeleton, Text } from "@mantine/core";
import { useTaskComment } from "domains/board-tasks";
import { MarkdownView } from "ui/markdown-view";
import { isDefined } from "shared/value-predicates";
import { describeActivityEntry } from "../../helpers/activity-presentation";
import type { DiscussionMessageProps } from "./types/discussion-message-props.type";
import styles from "./styles/discussion-message.module.css";

/**
 * Разделяет авторство сообщения и его содержание в одном компактном блоке.
 *
 * Используется для:
 *  - чтения коротких сообщений и развёрнутого Markdown
 */
export const DiscussionMessage = (props: DiscussionMessageProps) => {
  const { projectId, taskId, entry, active, className, ...rootAttrs } = props;
  const titleId = useId();
  const query = useTaskComment(projectId, taskId, active ? entry.id : null);
  const authorData = describeActivityEntry(entry);
  const hasRole = authorData.role !== "";
  const hasDescription = isDefined(query.data?.description);
  const hasError = isDefined(query.error);
  const description = query.data?.description ?? "";
  return (
    <article {...rootAttrs} className={clsx(styles.root, className)} aria-labelledby={titleId}>
      <header className={styles.header}>
        <div className={styles.byline}>
          <Text component="span" className={styles.author}>
            {entry.actor}
          </Text>
          {hasRole && (
            <Text component="span" className={styles.role}>
              {authorData.role}
            </Text>
          )}
        </div>
        <Text
          component="time"
          dateTime={entry.at}
          title={authorData.timestamp}
          className={styles.time}
        >
          {authorData.time}
        </Text>
      </header>
      <div className={styles.content}>
        <Text component="h4" id={titleId} className={styles.title}>
          {entry.title}
        </Text>
        {query.isLoading && <Skeleton height={14} width="65%" mt={8} />}
        {hasError && (
          <div role="alert" className={styles.error}>
            <Text size="sm" c="red">
              {query.error?.message}
            </Text>
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => void query.mutate().catch(() => undefined)}
            >
              Повторить загрузку
            </Button>
          </div>
        )}
        {hasDescription && <MarkdownView text={description} compact />}
      </div>
    </article>
  );
};
