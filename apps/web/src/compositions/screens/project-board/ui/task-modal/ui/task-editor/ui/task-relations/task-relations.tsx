import { useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Combobox,
  InputBase,
  useCombobox,
  Select,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useDebouncedValue } from "@mantine/hooks";
import { X, Plus, Circle, CheckCircle2, Ban } from "lucide-react";
import {
  BoardTaskError,
  TASK_COLUMNS,
  linkBoardTask,
  useBoardTasks,
  useBoardTaskRefresh,
  useBoardTask,
} from "domains/board-tasks";
import type { TaskSummary } from "domains/board-tasks";
import { useBoards } from "domains/boards";
import { MarkdownView } from "ui/markdown-view";
import { isEmptyArray } from "shared/value-predicates";
import type { TaskRelationsProps } from "./types/task-relations-props.type";
import type { SubtaskFormValues } from "./types/subtask-form-values.type";
import styles from "./styles/task-relations.module.css";

/**
 * Показывает обязательные подзадачи и позволяет добавлять задачи с разных досок.
 *
 * Используется для:
 *  - чтения состава работы и статусов её подзадач
 *  - поиска существующей задачи и изменения её родительства
 */
export const TaskRelations = (props: TaskRelationsProps) => {
  const { projectId, task, onOpen } = props;
  const [search, setSearch] = useState("");
  const [selectedBoard, setSelectedBoard] = useState<string | null>(task.boardSlug);
  const [isPreviewOpen, setPreviewOpen] = useState(false);
  const [debouncedSearch] = useDebouncedValue(search, 200);
  const [error, setError] = useState("");
  const [defect, setDefect] = useState<unknown>();
  const [isRemoving, setRemoving] = useState(false);
  const [isAdding, setAdding] = useState(false);
  const requests = useRef(new Map<string, string>());
  const searchInput = useRef<HTMLInputElement>(null);
  const boardInput = useRef<HTMLInputElement>(null);
  const dropdown = useRef<HTMLDivElement>(null);
  const query = useBoardTasks(projectId, { parentId: task.id });
  const boards = useBoards(projectId);
  const hasBoard = selectedBoard !== null;
  const boardItems =
    boards.data
      ?.flatMap((page) => page.items)
      .map((board) => ({ value: board.slug, label: board.name })) ?? [];
  const hasMoreBoards = boards.data !== undefined && boards.data.at(-1)?.nextOffset !== null;
  const candidates = useBoardTasks(
    projectId,
    {
      board: selectedBoard ?? undefined,
      q: debouncedSearch,
      completion: "unfinished",
      searchIn: "title",
    },
    isAdding && hasBoard,
  );
  const refresh = useBoardTaskRefresh(projectId);
  const form = useForm<SubtaskFormValues>({
    mode: "uncontrolled",
    validateInputOnBlur: true,
    initialValues: { target: "" },
    validate: { target: (value) => (value === "" ? "Выберите задачу" : null) },
  });
  const selectedId = form.useWatchValue("target");
  const selectedTask = useBoardTask(projectId, isAdding && selectedId !== "" ? selectedId : null);
  const taskSelect = useCombobox({
    onDropdownClose: () => {
      taskSelect.resetSelectedOption();
      setSearch("");
    },
  });
  const { resetSelectedOption, updateSelectedOptionIndex } = taskSelect;
  useEffect(() => {
    const activeId = searchInput.current?.getAttribute("aria-activedescendant");
    if (activeId && document.getElementById(activeId) !== null) {
      updateSelectedOptionIndex();
      return;
    }
    resetSelectedOption();
    // Mantine сохраняет прежний ID клавиатурного выбора при смене асинхронных вариантов.
    searchInput.current?.removeAttribute("aria-activedescendant");
  }, [
    resetSelectedOption,
    updateSelectedOptionIndex,
    candidates.data,
    search,
    selectedBoard,
    taskSelect.dropdownOpened,
  ]);
  const previewTitle = selectedTask.data?.title || "Без названия";
  const hasSelection = selectedId !== "";
  const shouldReplaceParent =
    selectedTask.data !== undefined &&
    selectedTask.data.parentId !== null &&
    selectedTask.data.parentId !== task.id;
  const items = query.data?.flatMap((page) => page.items) ?? [];
  const isAlreadyLinked = selectedTask.data?.parentId === task.id;
  const isSelectedFinished =
    selectedTask.data?.column === "done" || selectedTask.data?.column === "cancelled";
  const canAdd =
    hasSelection && selectedTask.data !== undefined && !isAlreadyLinked && !isSelectedFinished;
  const rows = items.map((entry) => ({
    ...entry,
    title: entry.title || "Без названия",
    columnLabel: TASK_COLUMNS.find((column) => column.value === entry.column)?.label,
    StatusIcon:
      entry.column === "done" ? CheckCircle2 : entry.column === "cancelled" ? Ban : Circle,
    statusColor: TASK_COLUMNS.find((column) => column.value === entry.column)?.color,
  }));
  const options =
    candidates.data
      ?.flatMap((page) => page.items)
      .filter(
        (entry) => entry.id !== task.id && entry.column !== "done" && entry.column !== "cancelled",
      )
      .map((entry) => ({
        value: entry.id,
        label: `${entry.key} · ${entry.title || "Без названия"}`,
        title: entry.title || "Без названия",
        key: entry.key,
        board: entry.boardSlug,
        status: TASK_COLUMNS.find((column) => column.value === entry.column)?.label,
        isLinked: entry.parentId === task.id,
      })) ?? [];
  const hasNoCandidates =
    isAdding &&
    hasBoard &&
    !candidates.isLoading &&
    candidates.error === undefined &&
    isEmptyArray(options);
  const isEmpty = isEmptyArray(items) && !query.isLoading && query.error === undefined;
  const hasError = error !== "";
  const hasQueryError = query.error !== undefined || candidates.error !== undefined;
  const hasMore = query.data !== undefined && query.data.at(-1)?.nextOffset !== null;
  const hasMoreCandidates =
    candidates.data !== undefined && candidates.data.at(-1)?.nextOffset !== null;
  const isBusy = form.submitting || isRemoving;
  const addLabel = isAdding ? "Свернуть" : "Добавить подзадачу";
  const selectedLabel =
    selectedTask.data === undefined
      ? (options.find((item) => item.value === selectedId)?.label ?? "")
      : `${selectedTask.data.key} · ${previewTitle}`;
  const inputText = taskSelect.dropdownOpened ? search : selectedLabel;
  const isSearching = candidates.isLoading || search !== debouncedSearch;
  const visibleOptions = isSearching ? [] : options;
  const shouldShowNoCandidates = hasNoCandidates && !isSearching;
  const shouldShowPreview = hasSelection && isPreviewOpen;
  const previewLabel = isPreviewOpen ? "Скрыть описание" : "Посмотреть описание";
  const cancelledCount = items.filter((entry) => entry.column === "cancelled").length;
  const cancelledLabel = cancelledCount > 0 ? ` · ${cancelledCount} отменено` : "";
  const shouldShowProgress = !isEmptyArray(items);
  const progressLabel = hasMore
    ? `Загружено ${items.length} из ${query.data?.[0]?.total ?? 0} подзадач`
    : `${items.filter((entry) => entry.column === "done").length} из ${items.length} готово${cancelledLabel}`;
  /**
   * Сохраняет родительство с ревизией ребёнка и корреляцией запроса.
   */
  const handleWrite = async (child: TaskSummary, remove = false): Promise<boolean> => {
    setError("");
    const input = { target: task.id, ifRevision: child.revision, remove };
    const fingerprint = JSON.stringify([child.id, input]);
    const requestId = requests.current.get(fingerprint) ?? crypto.randomUUID();
    requests.current.set(fingerprint, requestId);
    try {
      await linkBoardTask(projectId, child.id, { ...input, relation: "parent", requestId });
      await refresh(child.id);
      return true;
    } catch (failure) {
      if (failure instanceof BoardTaskError) setError(failure.message);
      else setDefect(failure);
      return false;
    }
  };
  /**
   * Привязывает выбранную задачу как обязательную подзадачу текущей.
   */
  const handleAdd = async (values: SubtaskFormValues): Promise<void> => {
    if (!canAdd || selectedTask.data === undefined || selectedTask.data.id !== values.target)
      return;
    const isSaved = await handleWrite(selectedTask.data);
    if (isSaved) {
      form.reset();
      setAdding(false);
    }
  };
  /**
   * Снимает родительство, сохраняя саму задачу и остальные её отношения.
   */
  const handleRemove = async (entry: TaskSummary): Promise<void> => {
    setRemoving(true);
    try {
      await handleWrite(entry, true);
    } finally {
      setRemoving(false);
    }
  };
  if (defect !== undefined) throw defect;
  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Text component="h3" m={0} fw={600} size="sm">
          Подзадачи
        </Text>
        <Button
          variant="subtle"
          color="gray"
          size="xs"
          aria-label={addLabel}
          aria-expanded={isAdding}
          onClick={() => {
            setAdding(!isAdding);
            if (!isAdding)
              requestAnimationFrame(() => {
                const input = hasBoard ? searchInput.current : boardInput.current;
                input?.closest("form")?.scrollIntoView({ block: "start" });
              });
          }}
          leftSection={<Plus size={14} />}
        >
          {addLabel}
        </Button>
      </Group>
      {isEmpty && (
        <Text size="sm" c="dimmed">
          Подзадач пока нет. Добавьте задачи, которые нужно выполнить для завершения текущей.
        </Text>
      )}
      {query.isLoading && (
        <Text size="sm" c="dimmed" role="status">
          Загружаем подзадачи…
        </Text>
      )}
      {shouldShowProgress && (
        <Text size="xs" c="dimmed" ta="right">
          {progressLabel}
        </Text>
      )}
      <Stack component="ul" aria-label="Подзадачи" gap={0} m={0} p={0}>
        {rows.map((entry) => (
          <Group
            component="li"
            key={entry.id}
            wrap="nowrap"
            align="flex-start"
            gap="xs"
            className={styles.row}
          >
            <entry.StatusIcon size={16} className={styles.statusIcon} aria-hidden="true" />
            <UnstyledButton
              onClick={() => onOpen(entry.id, entry.boardSlug)}
              className={styles.link}
            >
              <span className={styles.key}>{entry.key}</span>
              <span>{entry.title}</span>
            </UnstyledButton>
            <Group gap={4}>
              <Badge
                size="xs"
                variant="light"
                color={entry.statusColor}
                tt="none"
                className={styles.status}
              >
                {entry.columnLabel}
              </Badge>
              {entry.blocked && (
                <Badge size="xs" color="red" variant="light">
                  Заблокирована
                </Badge>
              )}
            </Group>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={`Убрать подзадачу ${entry.key}`}
              disabled={isBusy}
              onClick={() => void handleRemove(entry)}
            >
              <X size={14} />
            </ActionIcon>
          </Group>
        ))}
      </Stack>
      {hasMore && (
        <Button
          variant="subtle"
          size="xs"
          loading={query.isValidating}
          onClick={() => void query.setSize(query.size + 1).catch(() => undefined)}
        >
          Ещё подзадачи
        </Button>
      )}
      {hasQueryError && (
        <Alert color="red" title="Ошибка чтения задач">
          {query.error?.message ?? candidates.error?.message}
          <Button
            variant="subtle"
            size="xs"
            onClick={() =>
              void Promise.all([
                query.setSize(1).then(() => query.mutate()),
                candidates.setSize(1).then(() => candidates.mutate()),
              ]).catch(() => undefined)
            }
          >
            Повторить
          </Button>
        </Alert>
      )}
      <form hidden={!isAdding} onSubmit={form.onSubmit(handleAdd)}>
        <fieldset className={styles.fields} disabled={isBusy}>
          <Stack gap="md">
            <div className={styles.selectors}>
              <Select
                ref={boardInput}
                label="Доска"
                placeholder="Выберите доску"
                searchable
                allowDeselect={false}
                data={boardItems}
                value={selectedBoard}
                disabled={isBusy || boards.isLoading}
                nothingFoundMessage="Доски не найдены"
                onChange={(value) => {
                  setSelectedBoard(value);
                  setSearch("");
                  form.setFieldValue("target", "");
                  setPreviewOpen(false);
                  setError("");
                }}
              />
              <Combobox
                store={taskSelect}
                withinPortal={false}
                onOptionSubmit={(value) => {
                  form.setFieldValue("target", value);
                  setPreviewOpen(false);
                  taskSelect.closeDropdown();
                }}
              >
                <Combobox.Target withExpandedAttribute>
                  <InputBase
                    role="combobox"
                    aria-autocomplete="list"
                    ref={searchInput}
                    label="Задача"
                    placeholder="Выберите задачу"
                    error={form.errors.target}
                    value={inputText}
                    disabled={!hasBoard || isBusy}
                    rightSection={<Combobox.Chevron />}
                    rightSectionPointerEvents="none"
                    onClick={() => taskSelect.openDropdown()}
                    onBlur={(event) => {
                      if (!(
                        event.relatedTarget instanceof Node &&
                        dropdown.current?.contains(event.relatedTarget)
                      ))
                        taskSelect.closeDropdown();
                    }}
                    onChange={(event) => {
                      setSearch(event.currentTarget.value);
                      form.setFieldValue("target", "");
                      setPreviewOpen(false);
                      taskSelect.openDropdown();
                      taskSelect.updateSelectedOptionIndex();
                    }}
                  />
                </Combobox.Target>
                <Combobox.Dropdown
                  ref={dropdown}
                  onBlur={(event) => {
                    if (
                      event.relatedTarget !== searchInput.current &&
                      !(
                        event.relatedTarget instanceof Node &&
                        dropdown.current?.contains(event.relatedTarget)
                      )
                    )
                      taskSelect.closeDropdown();
                  }}
                >
                  <Combobox.Options
                    aria-label="Задачи выбранной доски"
                    className={styles.dropdownOptions}
                    tabIndex={0}
                  >
                    {isSearching && <Combobox.Empty>Ищем задачи…</Combobox.Empty>}
                    {shouldShowNoCandidates && (
                      <Combobox.Empty>Нет подходящих незавершённых задач</Combobox.Empty>
                    )}
                    {visibleOptions.map((option) => (
                      <Combobox.Option
                        key={option.value}
                        value={option.value}
                        disabled={option.isLinked}
                      >
                        <Group gap="xs" wrap="nowrap" justify="space-between">
                          <div className={styles.optionText}>
                            <Text size="xs" c="dimmed">
                              {option.key}
                            </Text>
                            <Text size="sm" lineClamp={2}>
                              {option.title}
                            </Text>
                          </div>
                          <Badge size="xs" variant="light" color="gray" tt="none">
                            {option.status}
                          </Badge>
                        </Group>
                        {option.isLinked && (
                          <Text size="xs" c="dimmed">
                            Уже добавлена в подзадачи
                          </Text>
                        )}
                      </Combobox.Option>
                    ))}
                  </Combobox.Options>
                  {hasMoreCandidates && (
                    <Combobox.Footer>
                      <Button
                        variant="subtle"
                        size="xs"
                        fullWidth
                        loading={candidates.isValidating}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          searchInput.current?.focus({ preventScroll: true });
                          void candidates.setSize(candidates.size + 1).catch(() => undefined);
                        }}
                      >
                        Показать ещё задачи
                      </Button>
                    </Combobox.Footer>
                  )}
                </Combobox.Dropdown>
              </Combobox>
            </div>
            {hasMoreBoards && (
              <Button
                size="xs"
                variant="subtle"
                onClick={() => void boards.setSize(boards.size + 1).catch(() => undefined)}
              >
                Ещё доски
              </Button>
            )}
            {boards.error !== undefined && (
              <Alert color="red">
                Не удалось загрузить доски.{" "}
                <Button
                  variant="subtle"
                  onClick={() => void boards.mutate().catch(() => undefined)}
                >
                  Повторить
                </Button>
              </Alert>
            )}
            {hasSelection && (
              <Group justify="space-between" gap="xs">
                <Text size="xs" c="dimmed">
                  Для завершения текущей задачи нужно выполнить все её подзадачи.
                </Text>
                <Button
                  variant="subtle"
                  color="gray"
                  size="xs"
                  onClick={() => setPreviewOpen(!isPreviewOpen)}
                >
                  {previewLabel}
                </Button>
              </Group>
            )}
            {shouldShowPreview && (
              <div className={styles.preview}>
                {selectedTask.isLoading && (
                  <Text role="status" size="sm">
                    Загружаем описание…
                  </Text>
                )}
                {selectedTask.error !== undefined && (
                  <Alert color="red">
                    Не удалось загрузить описание.
                    <Button
                      variant="subtle"
                      onClick={() => void selectedTask.mutate().catch(() => undefined)}
                    >
                      Повторить
                    </Button>
                  </Alert>
                )}
                {selectedTask.data !== undefined && (
                  <Stack gap="sm">
                    <Text size="xs" c="dimmed">
                      {selectedTask.data.key}
                    </Text>
                    <Text fw={600}>{previewTitle}</Text>
                    <MarkdownView
                      text={selectedTask.data.description}
                      emptyText="Описание не заполнено."
                    />
                  </Stack>
                )}
              </div>
            )}
            {hasSelection && (
              <Stack gap="sm">
                {isSelectedFinished && (
                  <Text size="sm" c="dimmed">
                    Задача уже завершена или отменена. Выберите другую.
                  </Text>
                )}
                {isAlreadyLinked && (
                  <Text size="sm" c="dimmed">
                    Эта задача уже добавлена в подзадачи.
                  </Text>
                )}
                {shouldReplaceParent && (
                  <Alert color="orange">Сохранение заменит прежнюю родительскую связь.</Alert>
                )}
              </Stack>
            )}
            <Group justify="flex-end">
              <Button
                variant="subtle"
                color="gray"
                onClick={() => {
                  setAdding(false);
                  form.reset();
                }}
              >
                Отмена
              </Button>
              <Button type="submit" disabled={!canAdd} loading={form.submitting}>
                Добавить подзадачу
              </Button>
            </Group>
          </Stack>
        </fieldset>
      </form>
      {hasError && (
        <Alert color="red" title="Подзадачи не изменены" role="alert">
          {error}
        </Alert>
      )}
    </Stack>
  );
};
