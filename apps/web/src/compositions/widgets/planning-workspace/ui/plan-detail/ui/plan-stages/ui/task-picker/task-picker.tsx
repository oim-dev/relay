import { useState } from "react";
import { Alert, Button, Checkbox, Group, Modal, Select, Switch, TextInput } from "@mantine/core";
import { Search } from "lucide-react";
import { z } from "zod";
import {
  PLANNING_TASK_LABELS,
  usePlanningCandidates,
  changePlanTasks,
  usePlanningRefresh,
  PlanningError,
} from "domains/planning";
import { useBoards } from "domains/boards";
import { useProjectId } from "domains/project";
import { readSessionValue, removeSessionStored, writeSessionStored } from "infra/browser-storage";
import { isDefined, isEmptyArray } from "shared/value-predicates";
import type { TaskPickerProps } from "./types/task-picker-props.type";
import styles from "./styles/task-picker.module.css";

/**
 * Выбирает существующие задачи, сохраняя отмеченные строки вне фильтра.
 *
 * Используется для:
 *  - комплектования этапа задачами нескольких досок
 *  - явного подтверждения состава с исходной ревизией плана
 */
export const TaskPicker = (props: TaskPickerProps) => {
  const { plan, stage, onClose } = props;
  const projectId = useProjectId();
  const refresh = usePlanningRefresh(projectId);
  const boardsQuery = useBoards(projectId);
  const storageKey = `relay:planning-selection:server-v2:${projectId}:${plan.id}:${stage.id}`;
  const [draft] = useState(() => {
    const stored = readSessionValue(storageKey);
    const raw = stored.value;
    const parsed = z
      .object({
        selectedIds: z.array(z.string()),
        baseIds: z.array(z.string()),
        revision: z.number().int().positive(),
      })
      .safeParse(raw);
    return {
      values: parsed.success
        ? parsed.data
        : { selectedIds: stage.taskIds, baseIds: stage.taskIds, revision: plan.revision },
      error:
        stored.error ??
        (!parsed.success && isDefined(raw)
          ? "Черновик выбора повреждён. Отбросьте его явно и перечитайте этап."
          : null),
    };
  });
  const [selectedIds, setSelectedIds] = useState(draft.values.selectedIds);
  const [query, setQuery] = useState("");
  const [board, setBoard] = useState("all");
  const [isAvailableOnly, setAvailableOnly] = useState(true);
  const [limit, setLimit] = useState(12);
  const [error, setError] = useState<string | null>(draft.error);
  const [isSaving, setIsSaving] = useState(false);
  const [canPersist, setCanPersist] = useState(true);
  const candidates = usePlanningCandidates(
    projectId,
    {
      q: query,
      plan: plan.id,
      stage: stage.id,
      isAvailableOnly,
      ...(board === "all" ? {} : { board }),
    },
    limit,
  );
  const boards = boardsQuery.data?.flatMap((page) => page.items) ?? [];
  const hasMoreBoards = isDefined(boardsQuery.data?.at(-1)?.nextOffset);
  const boardItems = [
    { value: "all", label: "Все доски" },
    ...boards.map((entry) => ({ value: entry.slug, label: entry.name })),
  ];
  const taskItems = (candidates.data?.items ?? []).map((task) => {
    const isSelected = selectedIds.includes(task.id);
    const hasOtherAssignment =
      isDefined(task.assignment) &&
      (task.assignment.stageId !== stage.id || task.assignment.planId !== plan.id);
    const isUnavailable =
      hasOtherAssignment ||
      (task.status === "cancelled" && !draft.values.baseIds.includes(task.id));
    return {
      ...task,
      isSelected,
      isUnavailable,
      isDisabled: isSaving || (isUnavailable && !isSelected),
      unavailabilityLabel: hasOtherAssignment
        ? `В плане ${task.assignment?.label}`
        : "Отменённую задачу нельзя добавить в этап",
      statusLabel: PLANNING_TASK_LABELS[task.status],
    };
  });
  const hiddenCount = selectedIds.filter((id) => !taskItems.some((task) => task.id === id)).length;
  const hasHiddenSelection = hiddenCount > 0;
  const total = candidates.data?.total ?? 0;
  const hasMore = isDefined(candidates.data?.nextOffset);
  const hasReadError = isDefined(candidates.error) || isDefined(boardsQuery.error);
  // Отказ чтения без данных не выдаётся за пустой результат.
  const foundLabel = `Найдено: ${isDefined(candidates.data) ? total : hasReadError ? "—" : 0}`;
  const isEmpty = !candidates.isLoading && !hasReadError && isEmptyArray(taskItems);
  const hasError = isDefined(error);
  const hasSelection = !isEmptyArray(selectedIds);

  /**
   * Изменяет полный выбор, а не только видимую страницу.
   */
  const handleSelection = (nextIds: string[]) => {
    if (isSaving) return;
    if (draft.error !== null) {
      setError(draft.error);
      return;
    }
    setSelectedIds(nextIds);
    setCanPersist(writeSessionStored(storageKey, { ...draft.values, selectedIds: nextIds }));
    setError(null);
  };

  /**
   * Применяет разницу относительно исходного состава, не подменяя ревизию после SSE.
   */
  const handleApply = async () => {
    if (isSaving) return;
    if (draft.error !== null) {
      setError(draft.error);
      return;
    }
    if (selectedIds.length > 2000) {
      setError("В этапе допускается до 2000 задач. Уточните выбор.");
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await changePlanTasks(
        projectId,
        plan.id,
        draft.values.revision,
        { ...stage, taskIds: draft.values.baseIds },
        selectedIds,
      );
      void refresh().catch(() => undefined);
      removeSessionStored(storageKey);
      onClose();
    } catch (error) {
      if (error instanceof PlanningError) setError(error.message);
      else throw error;
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal
      attributes={{ header: { role: "presentation" } }}
      opened
      onClose={() => {
        if (!isSaving) onClose();
      }}
      closeOnClickOutside={!isSaving}
      closeOnEscape={!isSaving}
      withCloseButton={!isSaving}
      title="Выбрать задачи"
      size="lg"
      closeButtonProps={{ "aria-label": "Свернуть выбор задач" }}
      classNames={{ title: styles.modalTitle, body: styles.modalBody }}
    >
      <div className={styles.root}>
        <div className={styles.destination}>
          <span>ЭТАП</span>
          <strong>{stage.title}</strong>
          <p>Задачи сохраняют свою доску и колонку.</p>
        </div>
        <div className={styles.toolbar}>
          <TextInput
            className={styles.search}
            placeholder="Название или ключ задачи"
            aria-label="Поиск задач"
            leftSection={<Search size={14} />}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setLimit(12);
            }}
          />
          <Select
            className={styles.board}
            aria-label="Доска задач"
            data={boardItems}
            value={board}
            onChange={(next) => {
              setBoard(next ?? "all");
              setLimit(12);
            }}
            allowDeselect={false}
          />
        </div>
        {hasMoreBoards && (
          <Button
            variant="subtle"
            size="xs"
            onClick={() => void boardsQuery.setSize(boardsQuery.size + 1)}
          >
            Показать ещё доски
          </Button>
        )}
        <div className={styles.options}>
          <Switch
            label="Только свободные задачи"
            size="xs"
            checked={isAvailableOnly}
            onChange={(event) => {
              setAvailableOnly(event.currentTarget.checked);
              setLimit(12);
            }}
          />
          <span role="status">{foundLabel}</span>
        </div>
        {candidates.isLoading && <p role="status">Загружаем задачи…</p>}
        {hasReadError && (
          <Alert color="red">
            {candidates.error?.message ?? boardsQuery.error?.message}
            <Button
              size="xs"
              variant="subtle"
              onClick={() => {
                void candidates.mutate();
                void boardsQuery.mutate();
              }}
            >
              Повторить чтение
            </Button>
          </Alert>
        )}
        <div className={styles.list}>
          {taskItems.map((task) => (
            <label
              className={styles.task}
              key={task.id}
              data-selected={task.isSelected}
              data-disabled={task.isDisabled}
            >
              <Checkbox
                checked={task.isSelected}
                disabled={task.isDisabled}
                aria-label={`Выбрать ${task.key}`}
                size="xs"
                onChange={(event) =>
                  handleSelection(
                    event.currentTarget.checked
                      ? [...selectedIds, task.id]
                      : selectedIds.filter((id) => id !== task.id),
                  )
                }
              />
              <span className={styles.taskBody}>
                <span className={styles.taskTitle}>{task.title}</span>
                <span className={styles.taskMeta}>
                  <span className={styles.key}>{task.key}</span>
                  {task.board}
                  <span>{task.statusLabel}</span>
                </span>
                {task.isUnavailable && (
                  <span className={styles.assignment}>{task.unavailabilityLabel}</span>
                )}
              </span>
            </label>
          ))}
          {isEmpty && (
            <div className={styles.empty}>
              <Search size={22} />
              <strong>Задачи не найдены</strong>
              <span>Измените запрос, доску или включите занятые задачи.</span>
            </div>
          )}
          {hasMore && (
            <Button
              variant="subtle"
              fullWidth
              loading={candidates.isValidating}
              onClick={() => setLimit(limit + 12)}
            >
              Показать ещё · {taskItems.length} из {total}
            </Button>
          )}
        </div>
        {!canPersist && (
          <Alert color="orange">
            Выбор не удалось сохранить в черновике. Примените его, прежде чем закрыть окно.
          </Alert>
        )}
        {hasError && (
          <Alert color="red">
            {error}
            <Button
              size="xs"
              variant="subtle"
              onClick={() => {
                removeSessionStored(storageKey);
                onClose();
              }}
            >
              Отбросить выбор и перечитать
            </Button>
          </Alert>
        )}
        <footer className={styles.footer}>
          <div className={styles.selection} role="status">
            <strong>Выбрано: {selectedIds.length}</strong>
            {hasHiddenSelection && <span>Вне текущего списка: {hiddenCount}</span>}
            {hasSelection && (
              <button type="button" disabled={isSaving} onClick={() => handleSelection([])}>
                Снять выбор
              </button>
            )}
          </div>
          <Group gap="xs">
            <Button variant="default" disabled={isSaving} onClick={onClose}>
              Свернуть
            </Button>
            <Button onClick={handleApply} loading={isSaving}>
              Применить
            </Button>
          </Group>
        </footer>
      </div>
    </Modal>
  );
};
