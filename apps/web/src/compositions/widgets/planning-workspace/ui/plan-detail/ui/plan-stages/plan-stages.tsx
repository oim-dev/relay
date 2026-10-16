import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, Anchor, Button, Drawer, Skeleton } from "@mantine/core";
import { CircleAlert, Plus } from "lucide-react";
import { useProjectId, useProjectBasePath } from "domains/project";
import {
  usePlanStages,
  usePlanningRefresh,
  changePlanStage,
  PlanningError,
  EMPTY_PLAN_SUMMARY,
  PLANNING_TASK_LABELS,
  PLANNING_TASK_TONES,
} from "domains/planning";
import type { PlanStage } from "domains/planning";
import { useBoardTask, useTaskExecutionProgress } from "domains/board-tasks";
import { MarkdownView } from "ui/markdown-view";
import { StatePanel } from "ui/state-panel";
import { StatusBadge } from "ui/status-badge";
import { isDefined, isEmptyArray } from "shared/value-predicates";
import { StageRow } from "./ui/stage-row/stage-row";
import { TaskPicker } from "./ui/task-picker";
import { StageForm } from "./ui/stage-form";
import type { PlanStagesProps } from "./types/plan-stages-props.type";
import styles from "./styles/plan-stages.module.css";

/** Зафиксированный источник редактора этапа. */
type StageEditor = {
  /** Этап из прочитанной страницы. */
  stage: PlanStage;
  /** Ревизия той же страницы. */
  revision: number;
  /** Создание нового этапа. */
  isNew: boolean;
};

/**
 * Организует реальные этапы с независимыми страницами задач и адресным чтением.
 *
 * Используется для:
 *  - управления составом и порядком без передачи усечённого массива
 *  - просмотра актуальной задачи рядом с её этапом
 */
export const PlanStages = (props: PlanStagesProps) => {
  const { plan } = props;
  const projectId = useProjectId();
  const basePath = useProjectBasePath();
  const refresh = usePlanningRefresh(projectId);
  const [limit, setLimit] = useState(12);
  const query = usePlanStages(projectId, plan.id, limit);
  const [editor, setEditor] = useState<StageEditor | null>(null);
  const [picker, setPicker] = useState<StageEditor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [reasonPage, setReasonPage] = useState<{ offset: number; version?: string }>({ offset: 0 });
  const taskQuery = useBoardTask(projectId, selectedTaskId);
  const progressQuery = useTaskExecutionProgress(
    projectId,
    selectedTaskId,
    reasonPage.offset,
    reasonPage.version,
  );
  const stageItems = query.data?.items ?? [];
  const total = query.data?.total ?? plan.stageCount;
  const hasMore = isDefined(query.data?.nextOffset);
  const hasReadError = isDefined(query.error);
  const isEmpty = !query.isLoading && !hasReadError && isEmptyArray(stageItems);
  const canEdit = plan.status === "draft" || plan.status === "active";
  const hasError = isDefined(error);
  const taskData = taskQuery.data;
  const isTaskOpen = selectedTaskId !== null;
  const taskTitle = taskData?.title || "Задача";
  const taskStatus = isDefined(taskData) ? PLANNING_TASK_LABELS[taskData.column] : "";
  const taskTone = isDefined(taskData) ? PLANNING_TASK_TONES[taskData.column] : "neutral";
  const taskHref = isDefined(taskData)
    ? `${basePath}/boards/${taskData.boardSlug}/${taskData.id}`
    : basePath;
  const reasonItems = progressQuery.data?.reasons ?? [];
  const hasMoreReasons = isDefined(progressQuery.data?.nextOffset);
  const hasTaskError = isDefined(taskQuery.error);
  const hasProgressError = isDefined(progressQuery.error);
  const reasonsTitleId = useId();
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const stageDraftKey = `relay:planning-stage:server-v2:${projectId}:${plan.id}:${editor?.isNew ? "new" : editor?.stage.id}`;

  /**
   * Окна этапа снимаются вместе с состоянием, поэтому фокус после закрытия возвращает
   * владелец: к вызвавшей кнопке, а если её больше нет — к постоянной «Добавить этап».
   */
  useEffect(() => {
    if (isDefined(editor) || isDefined(picker) || returnFocusRef.current === null) return;
    const opener = returnFocusRef.current;
    returnFocusRef.current = null;
    const target = opener.isConnected ? opener : addButtonRef.current;
    target?.focus({ preventScroll: true });
  }, [editor, picker]);

  /**
   * Запоминает элемент, вызвавший окно этапа.
   */
  const rememberOpener = (): void => {
    if (document.activeElement instanceof HTMLElement)
      returnFocusRef.current = document.activeElement;
  };

  /**
   * Создаёт ввод этапа без предварительной записи пустой сущности.
   * Кнопка пустого состояния исчезнет с первым этапом, поэтому фокус вернётся к постоянной.
   */
  const handleCreate = (): void => {
    returnFocusRef.current = addButtonRef.current;
    setEditor({
      revision: plan.revision,
      isNew: true,
      stage: {
        id: "new",
        title: "",
        summary: "",
        outcome: "",
        completionConditions: "",
        taskIds: [],
        progress: { ...EMPTY_PLAN_SUMMARY },
      },
    });
  };

  /**
   * Сохраняет текст по исходной ревизии редактора, независимо от SSE.
   */
  const handleSave = async (stage: PlanStage, revision: number): Promise<string | null> => {
    try {
      await changePlanStage(
        projectId,
        plan.id,
        revision,
        editor?.isNew ? "create" : "update",
        stage,
      );
      void refresh().catch(() => undefined);
      return null;
    } catch (error) {
      if (error instanceof PlanningError) return error.message;
      throw error;
    }
  };

  /**
   * Изменяет положение относительно полного серверного списка либо удаляет пустой этап.
   */
  const handleAction = async (
    stage: PlanStage,
    action: "remove" | "move",
    direction?: "up" | "down",
  ): Promise<void> => {
    if (!isDefined(query.data)) return;
    setIsBusy(true);
    setError(null);
    try {
      await changePlanStage(
        projectId,
        plan.id,
        query.data.planRevision,
        action,
        stage,
        undefined,
        direction,
      );
      void refresh().catch(() => undefined);
    } catch (error) {
      if (error instanceof PlanningError) setError(error.message);
      else throw error;
    } finally {
      setIsBusy(false);
    }
  };

  /**
   * Новая задача начинает адресное чтение причин с первой страницы.
   */
  const handleOpenTask = (id: string): void => {
    setReasonPage({ offset: 0 });
    setSelectedTaskId(id);
  };

  const emptyAction = canEdit ? (
    <Button
      variant="default"
      leftSection={<Plus size={16} aria-hidden="true" />}
      onClick={handleCreate}
    >
      Добавить этап
    </Button>
  ) : undefined;

  return (
    <div className={styles.root}>
      <div className={styles.intro}>
        <p>У каждого этапа — свой результат и понятный состав работ.</p>
        {canEdit && (
          <Button
            ref={addButtonRef}
            variant="default"
            size="xs"
            leftSection={<Plus size={16} aria-hidden="true" />}
            onClick={handleCreate}
          >
            Добавить этап
          </Button>
        )}
      </div>
      {hasError && (
        <Alert
          color="danger"
          title="Этап не изменён"
          withCloseButton
          closeButtonLabel="Скрыть сообщение"
          onClose={() => setError(null)}
        >
          {error}
        </Alert>
      )}
      {hasReadError && isDefined(query.data) && (
        <Alert color="warning" title="Не удалось обновить этапы">
          Показан последний прочитанный состав. {query.error?.message}
          <Button size="xs" variant="subtle" onClick={() => void query.mutate()}>
            Повторить чтение
          </Button>
        </Alert>
      )}
      {hasReadError && !isDefined(query.data) && (
        <StatePanel
          state="error"
          title="Этапы не удалось прочитать"
          description={query.error?.message ?? "Сервер не ответил на запрос этапов."}
          action={
            <Button variant="default" onClick={() => void query.mutate()}>
              Повторить чтение
            </Button>
          }
        />
      )}
      {query.isLoading && (
        <div className={styles.timeline} role="status" aria-label="Загружаем этапы">
          <Skeleton height={72} radius="xl" />
          <Skeleton height={72} radius="xl" />
        </div>
      )}
      {isEmpty && (
        <StatePanel
          title="Наметьте первый этап"
          description="Начните с ближайшего результата. Даже небольшому плану достаточно одного этапа."
          action={emptyAction}
        />
      )}
      {!isEmptyArray(stageItems) && (
        <ol className={styles.timeline} aria-label="Этапы плана">
          {stageItems.map((stage, index) => (
            <li key={stage.id} className={styles.timelineItem}>
              <StageRow
                planId={plan.id}
                stage={stage}
                index={index}
                total={total}
                canEdit={canEdit}
                isBusy={isBusy}
                onOpenTask={handleOpenTask}
                onEdit={() => {
                  rememberOpener();
                  setEditor({
                    stage,
                    revision: query.data?.planRevision ?? plan.revision,
                    isNew: false,
                  });
                }}
                onChoose={() => {
                  rememberOpener();
                  setPicker({
                    stage,
                    revision: query.data?.planRevision ?? plan.revision,
                    isNew: false,
                  });
                }}
                onRemove={() => void handleAction(stage, "remove")}
                onMove={(direction) => void handleAction(stage, "move", direction)}
              />
            </li>
          ))}
        </ol>
      )}
      {hasMore && (
        <Button
          variant="default"
          className={styles.more}
          loading={query.isValidating}
          onClick={() => setLimit(limit + 12)}
        >
          Показать ещё этапы · {stageItems.length} из {total}
        </Button>
      )}
      {isDefined(editor) && (
        <StageForm
          key={editor.stage.id}
          stage={editor.stage}
          revision={editor.revision}
          isNew={editor.isNew}
          draftKey={stageDraftKey}
          onSave={handleSave}
          onClose={() => setEditor(null)}
        />
      )}
      {isDefined(picker) && (
        <TaskPicker
          key={picker.stage.id}
          plan={{ ...plan, revision: picker.revision }}
          stage={picker.stage}
          onClose={() => setPicker(null)}
        />
      )}
      <Drawer
        opened={isTaskOpen}
        onClose={() => setSelectedTaskId(null)}
        title={taskTitle}
        position="right"
        size="lg"
        classNames={{ title: styles.drawerTitle }}
        closeButtonProps={{ "aria-label": "Закрыть просмотр задачи" }}
      >
        {taskQuery.isLoading && (
          <div className={styles.drawerBody} role="status" aria-label="Загружаем задачу">
            <Skeleton height={20} width="40%" />
            <Skeleton height={120} />
          </div>
        )}
        {hasTaskError && (
          <Alert color="danger" title="Задачу не удалось прочитать">
            {taskQuery.error?.message}
            <Button size="xs" variant="subtle" onClick={() => void taskQuery.mutate()}>
              Повторить чтение
            </Button>
          </Alert>
        )}
        {isDefined(taskData) && (
          <div className={styles.drawerBody}>
            <p className={styles.taskMeta}>
              <span className={styles.taskKey}>{taskData.key}</span>
              <span>Доска: {taskData.boardSlug}</span>
              <StatusBadge tone={taskTone}>{taskStatus}</StatusBadge>
            </p>
            <MarkdownView text={taskData.description} emptyText="Описание ещё не заполнено." />
            {hasProgressError && (
              <Alert color="danger" title="Прогресс задачи недоступен">
                {progressQuery.error?.message}
                <Button
                  size="xs"
                  variant="subtle"
                  onClick={() => {
                    setReasonPage({ offset: 0 });
                    void progressQuery.mutate();
                  }}
                >
                  Перечитать прогресс
                </Button>
              </Alert>
            )}
            {!isEmptyArray(reasonItems) && (
              <section className={styles.reasons} aria-labelledby={reasonsTitleId}>
                <h3 id={reasonsTitleId} className={styles.reasonsTitle}>
                  Невыполненные обязательства: {progressQuery.data?.reasonCount}
                </h3>
                <ul className={styles.reasonList}>
                  {reasonItems.map((reason, index) => (
                    <li key={`${reason.path}:${index}`}>
                      <CircleAlert size={16} aria-hidden="true" />
                      <Anchor component={Link} to={`${basePath}${reason.path}`}>
                        {reason.message}
                      </Anchor>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {hasMoreReasons && (
              <Button
                variant="subtle"
                size="xs"
                onClick={() =>
                  setReasonPage({
                    offset: progressQuery.data?.nextOffset ?? 0,
                    version: progressQuery.data?.version,
                  })
                }
              >
                Следующая страница причин · всего {progressQuery.data?.reasonCount}
              </Button>
            )}
            <Button component={Link} to={taskHref} variant="default" className={styles.openTask}>
              Открыть задачу на доске
            </Button>
          </div>
        )}
      </Drawer>
    </div>
  );
};
