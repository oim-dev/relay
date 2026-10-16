import { useDroppable } from "@dnd-kit/core";
import { useEffect, useId, useState } from "react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { ActionIcon, Alert, Button, Loader, Skeleton, Stack, Text } from "@mantine/core";
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
    onReadErrorChange,
  } = props;
  const [count, setCount] = useState(40);
  // Одна дополнительная запись служит точным якорем вставки на границе страницы.
  const { query, isOutdated } = useBoardTaskSlice(
    projectId,
    { ...filters, column: column.value },
    count + 1,
  );
  const hasError = query.error !== undefined;
  // Прежняя выдача при новом фильтре: во время загрузки приглушена и недоступна для переноса,
  // после ошибки не показывается вовсе — иначе она читалась бы как результат нового фильтра.
  const isRefreshing = isOutdated && !hasError;
  const visibleData = isOutdated && hasError ? undefined : query.data;
  const items = preview ?? visibleData?.items.slice(0, count) ?? [];
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
  // Пока полный счётчик не прочитан (загрузка или ошибка), число не показывается вместо ложного нуля.
  const total = previewTotal ?? (isOutdated ? undefined : query.data?.total);
  const hasTotal = total !== undefined;
  const isInteracting = activeId !== null || isSaving;
  const isLocked = isSaving || isOutdated;
  const canLoadMore = !isOutdated && query.data !== undefined && query.data.total > count;
  const isInitialLoading = query.isLoading && query.data === undefined;
  useEffect(() => {
    onReadErrorChange(column.value, hasError);
  }, [column.value, hasError, onReadErrorChange]);
  // Пустая колонка и отсутствие совпадений по поиску или фильтру сообщаются по-разному.
  const hasFilter = (filters.q ?? "") !== "" || filters.readiness !== undefined;
  const emptyText = hasFilter ? "Нет задач по условиям поиска" : "Здесь пока свободно";
  const isEmpty =
    isEmptyArray(items) && !isInitialLoading && !isRefreshing && query.error === undefined;
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
  const hasTargetsError = targets.error !== undefined;
  const id = `column:${column.value}`;
  const drop = useDroppable({
    id,
    data: { column: column.value, status: column.value },
    disabled: isLocked,
  });
  const isTarget = targetId === id;
  const titleId = useId();
  return (
    <section
      className={styles.root}
      data-column={column.value}
      data-active={drop.isOver}
      aria-labelledby={titleId}
      aria-busy={isRefreshing}
    >
      <header className={styles.header}>
        <span className={styles.mark} aria-hidden="true" />
        <h2 id={titleId} className={styles.title}>
          {column.label}
        </h2>
        {hasTotal && <span className={styles.count}>{total}</span>}
        {isRefreshing && <Loader size={14} aria-hidden="true" />}
        <ActionIcon
          aria-label={`Создать задачу: ${column.label}`}
          onClick={() => onCreate(column.value)}
          disabled={isInteracting}
          className={styles.create}
        >
          <Plus size={16} aria-hidden="true" />
        </ActionIcon>
      </header>
      <div className={styles.scroll}>
        {isInitialLoading && <Skeleton height="6.75rem" radius="lg" />}
        <Stack gap="sm" className={styles.cards} data-outdated={isRefreshing}>
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
                isDisabled={isLocked}
                onOpen={onOpen}
              />
            ))}
          </SortableContext>
        </Stack>
        {hasError && (
          // Ошибку объявляет доска один раз; сообщение колонки остаётся визуальным.
          <Alert color="danger" title="Ошибка загрузки" mt="sm" role="note">
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
            <Text size="sm" c="dimmed" ta="center" className={styles.empty}>
              {emptyText}
            </Text>
          )}
          <Button
            fullWidth
            variant="subtle"
            color="gray"
            size="xs"
            leftSection={<Plus size={14} aria-hidden="true" />}
            onClick={() => onCreate(column.value)}
            disabled={isInteracting}
            className={styles.create}
          >
            Добавить задачу
          </Button>
        </div>
      </div>
    </section>
  );
};
