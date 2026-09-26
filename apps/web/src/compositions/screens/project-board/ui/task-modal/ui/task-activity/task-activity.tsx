import clsx from "clsx";
import { useState } from "react";
import { ActionIcon, Alert, Button, Group, Loader, Stack, Text, Tooltip } from "@mantine/core";
import { RefreshCw } from "lucide-react";
import { useTaskComments } from "domains/board-tasks";
import { isDefined, isEmptyArray } from "shared/value-predicates";
import { CommentForm } from "./ui/comment-form/comment-form";
import { ActivityFeed } from "./ui/activity-feed/activity-feed";
import type { TaskActivityProps } from "./types/task-activity-props.type";
import styles from "./styles/task-activity.module.css";

/**
 * Читает обсуждения, сохраняя текущий снимок при внешних изменениях.
 *
 * Используется для:
 *  - публикации сообщений и чтения полного Markdown комментариев
 *  - подгрузки прежних записей без потери позиции чтения
 */
export const TaskActivity = (props: TaskActivityProps) => {
  const { projectId, taskId, active, className, ...rootAttrs } = props;
  const { query, latest } = useTaskComments(projectId, taskId, active);
  const [actionError, setActionError] = useState("");
  const activityItems = query.data?.flatMap((page) => page.items) ?? [];
  const hasMore = isDefined(query.data?.at(-1)?.nextCursor);
  const hasNew =
    (latest.data?.items[0]?.sequence ?? 0) > (query.data?.[0]?.items[0]?.sequence ?? 0);
  const hasError = isDefined(query.error) || actionError !== "";
  const errorMessage = query.error?.message ?? actionError;
  const isEmpty = !query.isLoading && !hasError && isEmptyArray(activityItems);
  const emptyMessage = "Обсуждение ещё не началось. Опубликуйте первое сообщение.";
  const canContinue = hasMore && !query.isValidating;
  /**
   * Загружает свежую первую страницу по явному действию, не затрагивая черновик.
   */
  const handleRefresh = async (): Promise<void> => {
    setActionError("");
    try {
      await query.setSize(1);
      await query.mutate();
      await latest.mutate();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Не удалось обновить ленту");
    }
  };
  /**
   * Продолжает чтение фиксированного снимка ленты.
   */
  const handleMore = async (): Promise<void> => {
    setActionError("");
    try {
      await query.setSize(query.size + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Не удалось продолжить чтение");
    }
  };
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <Stack gap="lg" className={styles.content}>
        <CommentForm projectId={projectId} taskId={taskId} onPublished={handleRefresh} />
        {hasNew && (
          <Button variant="light" onClick={() => void handleRefresh()}>
            Показать новые записи
          </Button>
        )}
        {hasError && (
          <Alert color="red" title="Не удалось прочитать ленту">
            {errorMessage}
          </Alert>
        )}
        {query.isLoading && <Loader size="sm" aria-label="Загрузка ленты" />}
        {isEmpty && <Text c="dimmed">{emptyMessage}</Text>}
        <ActivityFeed
          entries={activityItems}
          projectId={projectId}
          taskId={taskId}
          active={active}
        />
        <Group justify="space-between">
          <Text size="xs" c="dimmed">
            Показано: {activityItems.length}
          </Text>
          <Tooltip label="Обновить ленту">
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label="Обновить ленту"
              onClick={() => void handleRefresh()}
              loading={query.isValidating}
            >
              <RefreshCw size={15} />
            </ActionIcon>
          </Tooltip>
        </Group>
        {hasMore && (
          <Button variant="light" disabled={!canContinue} onClick={() => void handleMore()}>
            Показать более ранние записи
          </Button>
        )}
      </Stack>
    </div>
  );
};
