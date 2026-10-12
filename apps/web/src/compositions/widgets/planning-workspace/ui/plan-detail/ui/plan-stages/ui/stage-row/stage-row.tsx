import { useState } from "react";
import { ActionIcon, Alert, Button, Group, Progress, Skeleton } from "@mantine/core";
import { ArrowDown, ArrowUp, Check, ChevronDown, Pencil, Plus, Trash2 } from "lucide-react";
import { usePlanStageTasks } from "domains/planning";
import { useProjectId } from "domains/project";
import { MarkdownView } from "ui/markdown-view";
import { isDefined, isEmptyArray } from "shared/value-predicates";
import { PlanTask } from "../plan-task/plan-task";
import type { StageRowProps } from "./types/stage-row-props.type";
import styles from "./styles/stage-row.module.css";

/**
 * Сохраняет оформление этапа и независимо подгружает его реальные задачи.
 *
 * Используется для:
 *  - раскрытия результата этапа и полного серверного прогресса
 *  - чтения задач страницами без потери открытого состояния
 */
export const StageRow = (props: StageRowProps) => {
  const {
    planId,
    stage,
    index,
    total,
    canEdit,
    isBusy,
    onOpenTask,
    onEdit,
    onChoose,
    onRemove,
    onMove,
  } = props;
  const projectId = useProjectId();
  const isEmpty = stage.progress.total === 0;
  const isDone = !isEmpty && stage.progress.done === stage.progress.total;
  const isActive = stage.progress.active + stage.progress.review > 0;
  const hasPartialCompletion = !isDone && stage.progress.done > 0;
  const [isExpanded, setIsExpanded] = useState(isActive || isEmpty);
  const [limit, setLimit] = useState(12);
  const query = usePlanStageTasks(projectId, planId, stage.id, limit, isExpanded);
  const taskItems = query.data?.items ?? [];
  const hasMore = isDefined(query.data?.nextOffset);
  const hasError = isDefined(query.error);
  const label = isDone
    ? "Задачи готовы"
    : isActive
      ? "В работе"
      : hasPartialCompletion
        ? "Частично выполнен"
        : "Предстоит";
  const ordinal = String(index + 1).padStart(2, "0");
  const isFirst = index === 0;
  const isLast = index + 1 >= total;
  const hasConditions = stage.completionConditions.trim() !== "";
  const progressLabel = `${stage.progress.done} из ${stage.progress.total} задач`;
  return (
    <details
      className={styles.root}
      open={isExpanded}
      data-done={isDone}
      data-active={isActive}
      onToggle={(event) => setIsExpanded(event.currentTarget.open)}
    >
      <summary className={styles.header}>
        <span
          className={styles.marker}
          data-done={isDone}
          data-active={isActive}
          aria-hidden="true"
        >
          {isDone && <Check size={18} />}
          {!isDone && ordinal}
        </span>
        <span className={styles.identity}>
          <span className={styles.title}>{stage.title}</span>
          <span className={styles.meta}>
            <span className={styles.state} data-done={isDone} data-active={isActive}>
              {label}
            </span>
            <span aria-hidden="true">·</span>
            <span>{progressLabel}</span>
          </span>
        </span>
        <Progress
          variant="accent"
          value={stage.progress.percent}
          className={styles.miniProgress}
          aria-hidden="true"
        />
        <ChevronDown size={18} className={styles.chevron} aria-hidden="true" />
      </summary>
      <div className={styles.body}>
        <div className={styles.outcome}>
          <span className={styles.outcomeLabel}>Результат этапа</span>
          <MarkdownView text={stage.outcome} compact emptyText="Результат этапа ещё не описан." />
          {hasConditions && (
            <>
              <span className={styles.outcomeLabel}>Условия завершения</span>
              <MarkdownView text={stage.completionConditions} compact />
            </>
          )}
        </div>
        {query.isLoading && (
          <div className={styles.loading} role="status" aria-label="Загружаем задачи этапа">
            <Skeleton height={48} radius="md" />
            <Skeleton height={48} radius="md" />
          </div>
        )}
        {hasError && (
          <Alert color="danger" title="Задачи этапа не прочитаны" className={styles.alert}>
            {query.error?.message}
            <Button size="xs" variant="subtle" onClick={() => void query.mutate()}>
              Повторить чтение
            </Button>
          </Alert>
        )}
        {!isEmptyArray(taskItems) && (
          <ul className={styles.taskList} aria-label={`Задачи этапа «${stage.title}»`}>
            {taskItems.map((task) => (
              <li key={task.id}>
                <PlanTask task={task} onOpen={() => onOpenTask(task.id)} />
              </li>
            ))}
          </ul>
        )}
        {isEmpty && (
          <p className={styles.noTasks}>
            Задач пока нет. Выберите существующие задачи с любой доски.
          </p>
        )}
        {hasMore && (
          <Button
            variant="subtle"
            size="xs"
            className={styles.more}
            loading={query.isValidating}
            onClick={() => setLimit(limit + 12)}
          >
            Показать ещё · {taskItems.length} из {query.data?.total}
          </Button>
        )}
        {canEdit && (
          <div className={styles.actions}>
            <Button
              variant="default"
              size="xs"
              leftSection={<Plus size={16} aria-hidden="true" />}
              disabled={isBusy}
              onClick={onChoose}
            >
              Выбрать задачи
            </Button>
            <Group gap={4}>
              <ActionIcon
                disabled={isBusy}
                aria-label={`Изменить этап «${stage.title}»`}
                onClick={onEdit}
              >
                <Pencil size={16} aria-hidden="true" />
              </ActionIcon>
              <ActionIcon
                disabled={isBusy || isFirst}
                aria-label={`Поднять этап «${stage.title}»`}
                onClick={() => onMove("up")}
              >
                <ArrowUp size={16} aria-hidden="true" />
              </ActionIcon>
              <ActionIcon
                disabled={isBusy || isLast}
                aria-label={`Опустить этап «${stage.title}»`}
                onClick={() => onMove("down")}
              >
                <ArrowDown size={16} aria-hidden="true" />
              </ActionIcon>
              {isEmpty && (
                <ActionIcon
                  color="danger"
                  disabled={isBusy}
                  aria-label={`Удалить пустой этап «${stage.title}»`}
                  onClick={onRemove}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </ActionIcon>
              )}
            </Group>
          </div>
        )}
      </div>
    </details>
  );
};
