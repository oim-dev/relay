import clsx from "clsx";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useProjectBasePath, useProjectId } from "domains/project";
import { Alert, Anchor, Button, Progress, Text } from "@mantine/core";
import { ArrowUpRight } from "lucide-react";
import { useBoardTasks, useProductTaskProgress, TASK_COLUMNS } from "domains/board-tasks";
import { RecordRow } from "ui/record-row";
import { SectionPanel } from "ui/section-panel";
import { StatusBadge } from "ui/status-badge";
import type { StatusBadgeTone } from "ui/status-badge";
import { isEmptyArray } from "shared/value-predicates";
import type { ProductTasksProps } from "./types/product-tasks-props.type";
import styles from "./styles/product-tasks.module.css";

/**
 * Тон сохранённой колонки задачи: успех — только выполнение, подтверждённое обязательствами;
 * отменённая задача нейтральна, остальные считаются работой в процессе.
 */
const getColumnTone = (column: string, canComplete: boolean | undefined): StatusBadgeTone => {
  if (column === "done" && canComplete !== false) return "success";
  if (column === "cancelled") return "neutral";
  return "info";
};

/**
 * Показывает задачи продуктовой цели, включая задачи её активных имплементаций.
 *
 * Используется для:
 *  - перехода от требований к работе с постраничной загрузкой
 */
export const ProductTasks = (props: ProductTasksProps) => {
  const { targetId, scope, boardHref, className, ...rootAttrs } = props;
  const isExpanded = scope !== undefined;
  const isApplication = scope === "application";
  const boardLabel = isApplication ? "Открыть доску приложения" : "Открыть продуктовую доску";
  const emptyDescription = isApplication
    ? "Создайте задачу на доске приложения и укажите эту фичу или сценарий в разделе «Реализует в приложении»."
    : "Свяжите задачу с реализацией этой фичи или сценария на доске приложения либо укажите требование в задаче продуктовой доски.";
  const progressDescription = isApplication
    ? "Учитываются задачи реализации и её выбранных сценариев. Фича готова только после выполнения всех сценариев; процент ниже показывает прогресс задач."
    : "Учитываются задачи требования, его сценариев и активных реализаций приложений. Для готовности фичи все её сценарии и реализации должны быть выполнены.";
  const project = useProjectId();
  const base = useProjectBasePath();
  const [isOpen, setOpen] = useState(false);
  const [reasonPage, setReasonPage] = useState({
    target: targetId,
    offset: 0,
    version: undefined as string | undefined,
  });
  const reasonOffset = reasonPage.target === targetId ? reasonPage.offset : 0;
  const reasonVersion = reasonPage.target === targetId ? reasonPage.version : undefined;
  const canRead = project !== undefined && targetId !== undefined;
  const shouldShowTasks = isExpanded || isOpen;
  const query = useBoardTasks(
    project ?? "",
    { productTarget: targetId },
    canRead && shouldShowTasks,
  );
  const progress = useProductTaskProgress(
    project,
    isExpanded ? (targetId ?? null) : null,
    reasonOffset,
    reasonVersion,
  );
  const progressData = progress.data;
  const hasProgress = progressData !== undefined && progress.error === undefined;
  const progressValue =
    progressData === undefined || progressData.total === 0
      ? 0
      : Math.floor((progressData.completed / progressData.total) * 100);
  const progressLabel = `${progressData?.completed ?? 0} из ${progressData?.total ?? 0} завершено`;
  const hasProgressError = progress.error !== undefined;
  const readinessLabel = progressData?.isComplete
    ? "Обязательный состав выполнен"
    : "Обязательный состав ещё не выполнен";
  const reasonItems =
    progressData?.reasons.map((reason) => ({ ...reason, href: `${base}${reason.path}` })) ?? [];
  const hasMoreReasons = progressData !== undefined && progressData.nextOffset !== null;
  const canResetReasons = reasonOffset > 0;
  /**
   * Продолжает тот же снимок; при изменении пользователь явно возвращается к первой странице.
   */
  const handleNextReasons = (): void => {
    if (progressData === undefined || progressData.nextOffset === null) return;
    setReasonPage({
      target: targetId,
      offset: progressData.nextOffset,
      version: progressData.version,
    });
  };
  /**
   * Перечитывает причины после смены снимка, сохраняя состояние списка задач.
   */
  const handleResetReasons = (): void =>
    setReasonPage({ target: targetId, offset: 0, version: undefined });
  const isProgressLoading = isExpanded && progressData === undefined && !hasProgressError;
  const items =
    query.data
      ?.flatMap((page) => page.items)
      .map((task) => ({
        ...task,
        label: task.title || "Без названия",
        columnLabel:
          task.column === "done" && task.canComplete === false
            ? "Не выполнена"
            : TASK_COLUMNS.find((entry) => entry.value === task.column)?.label,
        columnTitle: `Сохранённая колонка: ${task.column}. Фактическое выполнение учитывает обязательства.`,
        tone: getColumnTone(task.column, task.canComplete),
        href: `${base}/boards/${task.boardSlug}/${task.id}`,
      })) ?? [];
  const hasMore = query.data !== undefined && query.data.at(-1)?.nextOffset !== null;
  const isEmpty = isEmptyArray(items) && !query.isLoading && query.error === undefined;
  const isCollapsedMode = !isExpanded;
  const emptyLabel = isExpanded
    ? "Реализация пока не запланирована"
    : "Явно связанных задач пока нет.";
  const hasTaskError = query.error !== undefined;
  const canOpenBoard = isExpanded && boardHref !== undefined;
  if (!canRead) return null;
  const taskList = shouldShowTasks && (
    <div className={styles.body}>
      {query.isLoading && (
        <Text role="status" size="sm" c="dimmed">
          Загружаем задачи…
        </Text>
      )}
      {isEmpty && (
        <div className={styles.empty}>
          <Text fw={600}>{emptyLabel}</Text>
          {isExpanded && (
            <Text size="sm" c="dimmed">
              {emptyDescription}
            </Text>
          )}
          {canOpenBoard && (
            <Button component={Link} to={boardHref} variant="default">
              {boardLabel}
            </Button>
          )}
        </div>
      )}
      {!isEmptyArray(items) && (
        <ul className={styles.tasks}>
          {items.map((task) => (
            <RecordRow
              key={task.id}
              component="li"
              code={task.key}
              title={
                <Link to={task.href}>
                  {task.label}
                  <ArrowUpRight size={15} aria-hidden="true" className={styles.taskIcon} />
                </Link>
              }
              trailing={
                <StatusBadge tone={task.tone} title={task.columnTitle}>
                  {task.columnLabel}
                </StatusBadge>
              }
            />
          ))}
        </ul>
      )}
      {hasMore && (
        <Button
          variant="subtle"
          className={styles.more}
          loading={query.isValidating}
          onClick={() => void query.setSize(query.size + 1).catch(() => undefined)}
        >
          Ещё задачи
        </Button>
      )}
      {hasTaskError && (
        <Alert color="danger" role="alert" title="Не удалось загрузить задачи">
          <Button
            size="compact-sm"
            variant="subtle"
            onClick={() =>
              void query
                .setSize(1)
                .then(() => query.mutate())
                .catch(() => undefined)
            }
          >
            Повторить
          </Button>
        </Alert>
      )}
    </div>
  );
  if (isCollapsedMode)
    return (
      <section
        {...rootAttrs}
        className={clsx(styles.root, className)}
        aria-label="Задачи реализации"
      >
        <Button variant="subtle" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}>
          Задачи реализации
        </Button>
        {taskList}
      </section>
    );
  return (
    <SectionPanel
      {...rootAttrs}
      className={clsx(styles.root, className)}
      title="Задачи реализации"
      description={progressDescription}
    >
      {isProgressLoading && (
        <Text size="sm" c="dimmed" role="status">
          Считаем прогресс…
        </Text>
      )}
      {hasProgress && (
        <div className={styles.progress}>
          <div className={styles.progressHeading}>
            <span className={styles.progressLabel}>{progressLabel}</span>
            <span className={styles.percent}>{progressValue}%</span>
          </div>
          <Progress variant="accent" value={progressValue} aria-label={progressLabel} />
          <Text size="sm">{readinessLabel}</Text>
          {reasonItems.map((reason, index) => (
            <Anchor key={`${reason.href}-${index}`} component={Link} to={reason.href} size="sm">
              {reason.message}
            </Anchor>
          ))}
          {hasMoreReasons && (
            <Button
              variant="subtle"
              size="compact-sm"
              className={styles.more}
              onClick={handleNextReasons}
            >
              Следующие причины
            </Button>
          )}
        </div>
      )}
      {hasProgressError && (
        <Alert color="warning" title="Прогресс недоступен">
          <Button size="compact-sm" variant="subtle" onClick={() => void progress.mutate()}>
            Повторить
          </Button>
        </Alert>
      )}
      {canResetReasons && (
        <Button
          variant="subtle"
          size="compact-sm"
          className={styles.more}
          onClick={handleResetReasons}
        >
          Перечитать прогресс с начала
        </Button>
      )}
      {taskList}
    </SectionPanel>
  );
};
