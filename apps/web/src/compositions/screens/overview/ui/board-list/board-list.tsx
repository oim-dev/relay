import { useId, useState } from "react";
import clsx from "clsx";
import { Button } from "@mantine/core";
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { useBoards } from "domains/boards";
import { useProjectId } from "domains/project";
import { isDefined } from "shared/value-predicates";
import { BOARD_KIND_LABELS } from "../../config/overview.config";
import type { BoardListProps } from "./types/board-list-props.type";
import styles from "./styles/board-list.module.css";
import listAction from "../../styles/list-action.module.css";

/**
 * Показывает доски проекта с числом открытых и всех задач, включая пустые доски.
 * Подборку можно раскрыть до полного каталога досок проекта, включая системные.
 *
 * Используется для:
 *  - перехода из обзора к канбану нужной доски
 */
export const BoardList = (props: BoardListProps) => {
  const { catalog, basePath, className, ...rootAttrs } = props;
  const listId = useId();
  const projectId = useProjectId();
  const [isExpanded, setExpanded] = useState(false);
  // Каталог уже читает навигация проекта: раскрытие использует тот же кеш и его продолжение.
  const boards = useBoards(projectId);
  const previewCounts = new Map(
    catalog.items.map((board) => [
      board.id,
      `открыто ${board.openTaskCount} из ${board.taskCount}`,
    ]),
  );
  const fullItems = (boards.data ?? []).flatMap((page) => page.items);
  const sourceItems = isExpanded ? fullItems : catalog.items;
  const boardItems = sourceItems.map((board) => ({
    id: board.id,
    prefix: board.prefix,
    name: board.name,
    path: `${basePath}/boards/${encodeURIComponent(board.slug)}`,
    countLabel: previewCounts.get(board.id) ?? BOARD_KIND_LABELS[board.kind],
  }));
  const lastPage = boards.data?.at(-1);
  const hasMorePages = isExpanded && isDefined(lastPage) && lastPage.nextOffset !== null;
  const isFullLoading = isExpanded && !isDefined(boards.data) && !isDefined(boards.error);
  const hasFullError = isExpanded && isDefined(boards.error);
  const canExpand = catalog.hasMore || isExpanded;
  const previewNote =
    !isExpanded && catalog.hasMore ? `Показано ${catalog.items.length} из ${catalog.total}` : null;
  const loadedNote =
    isExpanded && isDefined(lastPage) ? `Показано ${fullItems.length} из ${lastPage.total}` : null;
  const toggleLabel = isExpanded ? "Свернуть до подборки" : `Показать все доски: ${catalog.total}`;
  const ToggleIcon = isExpanded ? ChevronUp : ChevronDown;
  const handleMore = (): void => void boards.setSize(boards.size + 1).catch(() => undefined);
  const handleRetry = (): void =>
    void boards
      .setSize(1)
      .then(() => boards.mutate())
      .catch(() => undefined);
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <ul id={listId} className={styles.list} aria-busy={isFullLoading}>
        {boardItems.map((board) => (
          <li key={board.id}>
            <Link to={board.path} className={styles.link}>
              <span className={styles.prefix}>{board.prefix}</span>
              <span className={styles.name}>{board.name}</span>
              <span className={styles.count}>{board.countLabel}</span>
            </Link>
          </li>
        ))}
      </ul>
      {isFullLoading && (
        <p className={styles.note} role="status">
          Загружаем все доски…
        </p>
      )}
      {hasFullError && (
        <div className={styles.error} role="alert">
          <p>Не удалось загрузить каталог досок. Проверьте соединение и повторите.</p>
          <Button
            classNames={{ root: listAction.root, label: listAction.label }}
            size="compact-sm"
            variant="default"
            leftSection={<RefreshCw size={14} aria-hidden="true" />}
            onClick={handleRetry}
          >
            Перечитать доски
          </Button>
        </div>
      )}
      {isDefined(previewNote) && <p className={styles.note}>{previewNote}</p>}
      {isDefined(loadedNote) && <p className={styles.note}>{loadedNote}</p>}
      <div className={styles.actions}>
        {hasMorePages && (
          <Button
            classNames={{ root: listAction.root, label: listAction.label }}
            size="compact-sm"
            variant="subtle"
            className={styles.action}
            loading={boards.isValidating}
            onClick={handleMore}
          >
            Загрузить ещё доски
          </Button>
        )}
        {canExpand && (
          <Button
            classNames={{ root: listAction.root, label: listAction.label }}
            size="compact-sm"
            variant="subtle"
            className={styles.action}
            aria-expanded={isExpanded}
            aria-controls={listId}
            leftSection={<ToggleIcon size={14} aria-hidden="true" />}
            onClick={() => setExpanded(!isExpanded)}
          >
            {toggleLabel}
          </Button>
        )}
      </div>
    </div>
  );
};
