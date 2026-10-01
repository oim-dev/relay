import clsx from "clsx";
import { Button } from "@mantine/core";
import { RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { BoardTaskError, TASK_COLUMNS, useBoardTasks } from "domains/board-tasks";
import { useBoards } from "domains/boards";
import { useProjectId } from "domains/project";
import { isDefined, isEmptyArray, isNonEmptyArray } from "shared/value-predicates";
import { UNTITLED } from "../../../../../../config/overview.config";
import { AttentionTask } from "../../../attention-task/attention-task";
import type { AttentionFullListProps } from "./types/attention-full-list-props.type";
import styles from "./styles/attention-full-list.module.css";
import listAction from "../../../../../../styles/list-action.module.css";

const RELATION_LABELS = { dependency: "зависимость", subtask: "подзадача" } as const;
const READ_ERROR =
  "Не удалось прочитать полный список задач. Показана подборка обзора — повторите чтение.";

/**
 * Показывает весь набор задач группы внимания по проекту, включая задачи всех досок.
 * Загружает список только после явного раскрытия группы и продолжает его постранично.
 * Загруженные задачи упорядочены по доскам в порядке каталога, внутри доски — по рангу.
 * Задачи подборки сохраняют её карточку с адресными причинами блокировки; пока полный
 * список не прочитан или чтение не удалось, остаётся видна сама подборка.
 *
 * Используется для:
 *  - полного чтения групп «В работе», «На проверке» и «Заблокированы» сверх подборки обзора
 */
export const AttentionFullList = (props: AttentionFullListProps) => {
  const { filters, previewTasks, shouldShowColumn, basePath, className, ...rootAttrs } = props;
  const projectId = useProjectId();
  const query = useBoardTasks(projectId, filters);
  const boards = useBoards(projectId);
  const boardItems = (boards.data ?? []).flatMap((page) => page.items);
  const boardNames = new Map(boardItems.map((board) => [board.id, board.name]));
  const boardOrder = new Map(boardItems.map((board, index) => [board.id, index]));
  const previewById = new Map(previewTasks.map((task) => [task.id, task]));
  const pages = query.data ?? [];
  const lastPage = pages.at(-1);
  const loadedTasks = pages.flatMap((page) => page.items);
  // Ключи известных задач: подборка, её причины и загруженные страницы; иначе постоянный ID.
  const knownKeys = new Map([
    ...previewTasks.flatMap((task) => [
      [task.id, task.key] as const,
      ...task.blockers.items.map((blocker) => [blocker.id, blocker.key] as const),
    ]),
    ...loadedTasks.map((task) => [task.id, task.key] as const),
  ]);
  // Каждая порция упорядочена по доскам каталога и рангу; порции идут в порядке загрузки,
  // поэтому «Загрузить ещё» добавляет задачи в конец, не перемещая уже показанные.
  const sortedTasks = pages.flatMap((page) =>
    [...page.items].sort(
      (left, right) =>
        (boardOrder.get(left.boardId) ?? boardOrder.size) -
          (boardOrder.get(right.boardId) ?? boardOrder.size) ||
        left.boardSlug.localeCompare(right.boardSlug) ||
        left.rank - right.rank ||
        left.id.localeCompare(right.id),
    ),
  );
  const taskItems = sortedTasks.map((task) => {
    const acceptance = task.acceptance;
    const columnLabel = shouldShowColumn
      ? TASK_COLUMNS.find((column) => column.value === task.column)?.label
      : undefined;
    const metaItems = [
      boardNames.get(task.boardId) ?? task.boardSlug,
      columnLabel,
      acceptance.total === 0
        ? undefined
        : `Критерии ${acceptance.completed} из ${acceptance.total}`,
    ].filter(isDefined);
    const blockerNames = task.blockers
      .map((id) => {
        const relation = task.dependencies.includes(id) ? "dependency" : "subtask";
        return `${knownKeys.get(id) ?? id} (${RELATION_LABELS[relation]})`;
      })
      .join(", ");
    return {
      id: task.id,
      key: task.key,
      preview: previewById.get(task.id),
      columnLabel,
      title: task.title === "" ? UNTITLED : task.title,
      path: `${basePath}/boards/${encodeURIComponent(task.boardSlug)}/${encodeURIComponent(task.id)}`,
      metaItems,
      blockersLabel: blockerNames === "" ? null : `Ждёт: ${blockerNames}`,
    };
  });
  const hasData = isDefined(lastPage);
  const shouldShowPreview = !hasData && isNonEmptyArray(previewTasks);
  const hasMore = hasData && lastPage.nextOffset !== null;
  const isLoadingMore = query.isValidating && hasData && pages.length < query.size;
  const loadedLabel = hasData ? `Показано ${taskItems.length} из ${lastPage.total}` : null;
  const hasError = isDefined(query.error);
  const errorText =
    query.error instanceof BoardTaskError && query.error.code === "BOARD_CHANGED"
      ? query.error.message
      : READ_ERROR;
  const isEmpty = hasData && isEmptyArray(taskItems);
  const handleMore = (): void => void query.setSize(query.size + 1).catch(() => undefined);
  const handleRetry = (): void =>
    void query
      .setSize(1)
      .then(() => query.mutate())
      .catch(() => undefined);
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)} aria-busy={query.isLoading}>
      {query.isLoading && (
        <p className={styles.note} role="status">
          Загружаем все задачи группы…
        </p>
      )}
      {shouldShowPreview && (
        <ul className={styles.list}>
          {previewTasks.map((task) => (
            <li key={task.id}>
              <AttentionTask task={task} basePath={basePath} />
            </li>
          ))}
        </ul>
      )}
      {isNonEmptyArray(taskItems) && (
        <ul className={styles.list}>
          {taskItems.map((task) =>
            isDefined(task.preview) ? (
              <li key={task.id}>
                <AttentionTask
                  task={task.preview}
                  columnLabel={task.columnLabel}
                  basePath={basePath}
                />
              </li>
            ) : (
              <li key={task.id} className={styles.item}>
                <Link to={task.path} className={styles.link}>
                  <span className={styles.key}>{task.key}</span>
                  <span className={styles.title}>{task.title}</span>
                </Link>
                <p className={styles.meta}>
                  {task.metaItems.map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </p>
                {isDefined(task.blockersLabel) && (
                  <p className={styles.blockers}>{task.blockersLabel}</p>
                )}
              </li>
            ),
          )}
        </ul>
      )}
      {isEmpty && <p className={styles.note}>Сейчас таких задач нет.</p>}
      {isDefined(loadedLabel) && !isEmpty && <p className={styles.note}>{loadedLabel}</p>}
      {hasError && (
        <div className={styles.error} role="alert">
          <p>{errorText}</p>
          <Button
            classNames={{ root: listAction.root, label: listAction.label }}
            size="compact-sm"
            variant="default"
            leftSection={<RefreshCw size={14} aria-hidden="true" />}
            onClick={handleRetry}
          >
            Перечитать список
          </Button>
        </div>
      )}
      {hasMore && !hasError && (
        <Button
          classNames={{ root: listAction.root, label: listAction.label }}
          size="compact-sm"
          variant="subtle"
          className={styles.more}
          loading={isLoadingMore}
          onClick={handleMore}
        >
          Загрузить ещё
        </Button>
      )}
    </div>
  );
};
