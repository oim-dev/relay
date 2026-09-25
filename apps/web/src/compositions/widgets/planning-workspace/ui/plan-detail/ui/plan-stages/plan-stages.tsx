import { useState } from "react";
import { Link } from "react-router-dom";
import { Alert, Button, Drawer, Group } from "@mantine/core";
import { Layers3, Plus } from "lucide-react";
import { useProjectId, useProjectBasePath } from "domains/project";
import {
  usePlanStages,
  usePlanningRefresh,
  changePlanStage,
  PlanningError,
  EMPTY_PLAN_SUMMARY,
  PLANNING_TASK_LABELS,
} from "domains/planning";
import type { PlanStage } from "domains/planning";
import { useBoardTask, useTaskExecutionProgress } from "domains/board-tasks";
import { MarkdownView } from "ui/markdown-view";
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
  const taskHref = isDefined(taskData)
    ? `${basePath}/boards/${taskData.boardSlug}/${taskData.id}`
    : basePath;
  const reasonItems = progressQuery.data?.reasons ?? [];
  const hasMoreReasons = isDefined(progressQuery.data?.nextOffset);
  const hasTaskError = isDefined(taskQuery.error);
  const hasProgressError = isDefined(progressQuery.error);
  const stageDraftKey = `relay:planning-stage:server-v2:${projectId}:${plan.id}:${editor?.isNew ? "new" : editor?.stage.id}`;

  /**
   * Создаёт ввод этапа без предварительной записи пустой сущности.
   */
  const handleCreate = (): void =>
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

  return (
    <div className={styles.root}>
      <div className={styles.intro}>
        <p>У каждого этапа — свой результат и понятный состав работ.</p>
        {canEdit && (
          <Button
            variant="subtle"
            size="xs"
            leftSection={<Plus size={13} />}
            onClick={handleCreate}
          >
            Добавить этап
          </Button>
        )}
      </div>
      {hasError && (
        <Alert color="red" mb="md">
          {error}
        </Alert>
      )}
      {hasReadError && (
        <Alert color="red">
          {query.error?.message}
          <Button size="xs" variant="subtle" onClick={() => void query.mutate()}>
            Повторить
          </Button>
        </Alert>
      )}
      {query.isLoading && <p role="status">Загружаем этапы…</p>}
      {isEmpty && (
        <div className={styles.empty}>
          <Layers3 size={28} strokeWidth={1.3} />
          <h2>Наметьте первый этап</h2>
          <p>Начните с ближайшего результата. Даже небольшому плану достаточно одного этапа.</p>
        </div>
      )}
      <div className={styles.timeline}>
        {stageItems.map((stage, index) => (
          <StageRow
            key={stage.id}
            planId={plan.id}
            stage={stage}
            index={index}
            total={total}
            canEdit={canEdit}
            isBusy={isBusy}
            onOpenTask={handleOpenTask}
            onEdit={() =>
              setEditor({
                stage,
                revision: query.data?.planRevision ?? plan.revision,
                isNew: false,
              })
            }
            onChoose={() =>
              setPicker({
                stage,
                revision: query.data?.planRevision ?? plan.revision,
                isNew: false,
              })
            }
            onRemove={() => void handleAction(stage, "remove")}
            onMove={(direction) => void handleAction(stage, "move", direction)}
          />
        ))}
      </div>
      {hasMore && (
        <Button
          variant="default"
          fullWidth
          mt="md"
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
        closeButtonProps={{ "aria-label": "Закрыть просмотр задачи" }}
      >
        {taskQuery.isLoading && <p role="status">Загружаем задачу…</p>}
        {hasTaskError && (
          <Alert color="red">
            {taskQuery.error?.message}
            <Button onClick={() => void taskQuery.mutate()}>Повторить</Button>
          </Alert>
        )}
        {isDefined(taskData) && (
          <div>
            <Group mb="md">
              <strong>{taskData.key}</strong>
              <span>{taskData.boardSlug}</span>
              <span>{taskStatus}</span>
            </Group>
            <MarkdownView text={taskData.description} emptyText="Описание ещё не заполнено." />
            {hasProgressError && (
              <Alert color="red">
                {progressQuery.error?.message}
                <Button
                  size="xs"
                  onClick={() => {
                    setReasonPage({ offset: 0 });
                    void progressQuery.mutate();
                  }}
                >
                  Перечитать прогресс
                </Button>
              </Alert>
            )}
            {reasonItems.map((reason, index) => (
              <p key={`${reason.path}:${index}`}>
                <Link to={`${basePath}${reason.path}`}>{reason.message}</Link>
              </p>
            ))}
            {hasMoreReasons && (
              <Button
                variant="subtle"
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
            <Button component={Link} to={taskHref} variant="default" mt="lg">
              Открыть задачу на доске
            </Button>
          </div>
        )}
      </Drawer>
    </div>
  );
};
