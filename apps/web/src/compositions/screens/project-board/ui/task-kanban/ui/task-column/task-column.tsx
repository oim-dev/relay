import { useDroppable } from "@dnd-kit/core";
import { useEffect, useState } from "react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Paper,
  Skeleton,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { Plus } from "lucide-react";
import { useBoardTaskSlice } from "domains/board-tasks";
import { useProductTargetPreviews } from "domains/product";
import { isEmptyArray } from "shared/value-predicates";
import { TaskCard } from "./ui/task-card";
import type { TaskColumnProps } from "./types/task-column-props.type";
import styles from "./styles/task-column.module.css";

/**
 * Показывает одну колонку задач с постраничной загрузкой.
 *
 * Используется для:
 *  - сохранения полного счётчика и явного продолжения
 *  - создания задачи сразу в выбранной колонке
 */
export const TaskColumn = (props: TaskColumnProps) => {
  const {
    projectId,
    column,
    filters,
    targetId,
    isSaving,
    onOpen,
    onCreate,
    preview,
    previewTotal,
    activeId,
    activeSize,
    onSnapshot,
  } = props;
  const [count, setCount] = useState(40);
  // Одна дополнительная запись служит точным якорем вставки на границе страницы.
  const query = useBoardTaskSlice(projectId, { ...filters, column: column.value }, count + 1);
  const items = preview ?? query.data?.items.slice(0, count) ?? [];
  const targetIds = items.flatMap((task) => task.productLinks.slice(0, 1).map((link) => link.id));
  const targets = useProductTargetPreviews(projectId, targetIds);
  const targetState =
    targets.error !== undefined ? "error" : targets.isLoading ? "loading" : "ready";
  useEffect(() => {
    if (query.data !== undefined)
      onSnapshot(
        column.value,
        { ...query.data, items: query.data.items.slice(0, count) },
        query.data.items[count]?.id ?? null,
        targets.data,
        targetState,
      );
  }, [query.data, column.value, onSnapshot, count, targets.data, targetState]);
  const total = previewTotal ?? query.data?.total ?? 0;
  const isInteracting = activeId !== null || isSaving;
  const canLoadMore = query.data !== undefined && query.data.total > count;
  const isInitialLoading = query.isLoading && query.data === undefined;
  const isEmpty = isEmptyArray(items) && !isInitialLoading && query.error === undefined;
  const rows = items.map((task, index) => ({
    task,
    nextId: items[index + 1]?.id ?? query.data?.items[count]?.id ?? null,
    isTarget: targetId === task.id,
    isAfterTarget: targetId === `after:${task.id}`,
    target: targets.data?.get(task.productLinks[0]?.id ?? ""),
    isPlaceholder: task.id === activeId,
    placeholderSize: task.id === activeId ? activeSize : undefined,
  }));
  const loadLabel = `Показать ещё · ${items.length} из ${query.data?.total ?? "—"}`;
  const hasError = query.error !== undefined;
  const hasTargetsError = targets.error !== undefined;
  const id = `column:${column.value}`;
  const drop = useDroppable({
    id,
    data: { column: column.value, status: column.value },
    disabled: isSaving,
  });
  const isTarget = targetId === id;
  return (
    <Paper radius="lg" p={0} className={styles.root} data-active={drop.isOver}>
      <Group justify="space-between" gap="xs" wrap="nowrap" className={styles.header}>
        <Group gap="xs">
          <span className={styles.dot} style={{ color: `var(--tasks-column-${column.value})` }} />
          <Title order={2} size="sm">
            {column.label}
          </Title>
          <Text size="xs" c="dimmed">
            {total}
          </Text>
        </Group>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={`Создать задачу: ${column.label}`}
          onClick={() => onCreate(column.value)}
          disabled={isInteracting}
          className={styles.create}
        >
          <Plus size={16} />
        </ActionIcon>
      </Group>
      <div className={styles.scroll}>
        {isInitialLoading && <Skeleton height={108} radius="md" />}
        <Stack gap="sm">
          <SortableContext
            items={items.map((task) => task.id)}
            strategy={verticalListSortingStrategy}
          >
            {rows.map((row) => (
              <TaskCard
                key={row.task.id}
                {...row}
                version={query.data?.version ?? ""}
                targetState={targetState}
                isDisabled={isSaving}
                onOpen={onOpen}
              />
            ))}
          </SortableContext>
        </Stack>
        {hasError && (
          <Alert color="red" title="Ошибка загрузки" mt="sm">
            {query.error?.message}
            <Button variant="subtle" onClick={() => void query.mutate().catch(() => undefined)}>
              Повторить
            </Button>
          </Alert>
        )}
        {hasTargetsError && (
          <Button
            variant="subtle"
            size="xs"
            color="gray"
            mt="sm"
            onClick={() => void targets.mutate().catch(() => undefined)}
          >
            Повторить загрузку целей
          </Button>
        )}
        {canLoadMore && (
          <Button
            fullWidth
            variant="subtle"
            size="xs"
            color="gray"
            mt="sm"
            className={styles.loadMore}
            loading={query.isValidating}
            disabled={isInteracting}
            onClick={() => setCount(count + 40)}
          >
            {loadLabel}
          </Button>
        )}
        <div
          ref={drop.setNodeRef}
          className={styles.drop}
          data-target={isTarget}
          role="group"
          aria-label={`Конец колонки ${column.label}`}
        >
          {isEmpty && (
            <Text size="sm" c="dimmed" ta="center">
              Здесь пока свободно
            </Text>
          )}
          <Button
            fullWidth
            variant="subtle"
            color="gray"
            size="xs"
            leftSection={<Plus size={14} />}
            onClick={() => onCreate(column.value)}
            disabled={isInteracting}
            className={styles.create}
          >
            Добавить задачу
          </Button>
        </div>
      </div>
    </Paper>
  );
};
