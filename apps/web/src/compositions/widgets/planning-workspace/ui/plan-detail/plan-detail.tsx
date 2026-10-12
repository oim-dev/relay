import { useEffect, useId, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ActionIcon,
  Alert,
  Anchor,
  Button,
  Group,
  Menu,
  Modal,
  Progress,
  Tabs,
  Tooltip,
  VisuallyHidden,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import {
  ArrowLeft,
  Ban,
  Check,
  CircleAlert,
  FileText,
  Layers3,
  MoreHorizontal,
  Pencil,
} from "lucide-react";
import { z } from "zod";
import {
  getPlanSummary,
  PLAN_STATUS_LABELS,
  PLAN_STATUS_TONES,
  transitionPlan,
  usePlanningRefresh,
  PlanningError,
} from "domains/planning";
import { MarkdownView } from "ui/markdown-view";
import { MarkdownField } from "ui/markdown-field";
import { PageHeader } from "ui/page-header";
import { SectionPanel } from "ui/section-panel";
import { StatusBadge } from "ui/status-badge";
import { useProjectId } from "domains/project";
import { readSessionValue, removeSessionStored, writeSessionStored } from "infra/browser-storage";
import { isDefined } from "shared/value-predicates";
import { PlanStages } from "./ui/plan-stages";
import { PlanOverview } from "./ui/plan-overview/plan-overview";
import type { PlanDetailProps } from "./types/plan-detail-props.type";
import styles from "./styles/plan-detail.module.css";

/**
 * Раскрывает цель, маршрут по этапам и основания результата одного плана.
 *
 * Используется для:
 *  - чтения задач без потери контекста плана
 *  - чтения оснований и результата работы
 */
export const PlanDetail = (props: PlanDetailProps) => {
  const { plan, basePath, onEdit } = props;
  const [searchParams, setSearchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [transitionMode, setTransitionMode] = useState<"complete" | "cancel" | null>(null);
  const projectId = useProjectId();
  const refresh = usePlanningRefresh(projectId);
  const outcomeKey = `relay:planning-outcome:server-v2:${projectId}:${plan.id}`;
  const [storedOutcomeDraft] = useState(() => readSessionValue(outcomeKey));
  const [outcomeDraft] = useState(() =>
    z
      .object({ result: z.array(z.string()), revision: z.number().int().positive() })
      .safeParse(storedOutcomeDraft.value),
  );
  const [draftError, setDraftError] = useState(
    storedOutcomeDraft.error ??
      (!outcomeDraft.success && isDefined(storedOutcomeDraft.value)
        ? "Черновик итога имеет неизвестный формат. Отбросьте его явно, чтобы продолжить."
        : null),
  );
  const [hasOutcomeDraft, setHasOutcomeDraft] = useState(outcomeDraft.success);
  const [canPersistOutcome, setCanPersistOutcome] = useState(true);
  const outcomeForm = useForm({
    mode: "uncontrolled",
    initialValues: {
      result: outcomeDraft.success ? outcomeDraft.data.result.join("\n") : plan.result,
      revision: outcomeDraft.success ? outcomeDraft.data.revision : plan.revision,
    },
    validate: {
      result: (result) => (result.trim() === "" ? "Опишите результат или причину отмены" : null),
    },
    onValuesChange: (values) => {
      if (draftError !== null) return;
      setHasOutcomeDraft(true);
      setCanPersistOutcome(
        writeSessionStored(outcomeKey, {
          result: values.result.split("\n"),
          revision: values.revision,
        }),
      );
      setError(null);
    },
  });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shouldFocusClosed = useRef(false);
  const isCompleted = plan.status === "completed";
  const isCancelled = plan.status === "cancelled";
  const isDraft = plan.status === "draft";
  const isActive = plan.status === "active";
  const canEdit = isDraft || isActive;
  const summaryData = getPlanSummary(plan);
  const statusLabel = PLAN_STATUS_LABELS[plan.status];
  const canFinish = plan.isReady;
  const hasDivergence = isCompleted && !plan.isReady;
  const isActionDisabled = !canFinish;
  const actionHint =
    "Завершить план можно, когда весь его непустой состав фактически выполнен: задачи, их критерии и зависимости.";
  const actionHintId = useId();
  const defaultTab = "stages";
  const requestedTab = searchParams.get("tab") ?? defaultTab;
  const activeTab = ["stages", "overview"].includes(requestedTab) ? requestedTab : defaultTab;
  const dateLabel = new Intl.DateTimeFormat("ru", { day: "numeric", month: "long" }).format(
    new Date(plan.updatedAt),
  );
  const hasError = isDefined(error);
  const hasDraftError = isDefined(draftError);
  const hasBlockers = summaryData.blocked > 0;
  const hasResult = plan.result !== "";
  const resultLabel = isCancelled ? "Причина отмены" : "Итог плана";
  const otherCount = summaryData.total - summaryData.done - summaryData.active - summaryData.review;
  const progressLabel = `Выполнено задач: ${summaryData.done} из ${summaryData.total} (${summaryData.percent}%)`;
  const hasSummary = plan.summary.trim() !== "";
  const isTransitionOpen = isDefined(transitionMode);
  const transitionTitle = transitionMode === "cancel" ? "Отменить план" : "Завершить план";
  const outcomeLabel =
    transitionMode === "cancel" ? "Почему работа отменена" : "Итог и подтверждение результата";

  useEffect(() => {
    document.title = `${plan.title} · Relay`;
  }, [plan.title]);

  // Заголовок получает фокус при открытии плана, а не при каждом обновлении его данных.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [plan.id]);

  /*
   * После завершения или отмены действия плана исчезают вместе с прежним статусом,
   * поэтому фокус переходит к заголовку плана с новым статусом.
   */
  useEffect(() => {
    if (canEdit || !shouldFocusClosed.current) return;
    shouldFocusClosed.current = false;
    headingRef.current?.focus({ preventScroll: true });
  }, [canEdit]);

  /**
   * Переключает адресную вкладку без потери остальных параметров.
   */
  const handleTab = (tab: string | null) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("tab", tab ?? defaultTab);
      return next;
    });
  };

  /**
   * Закрепляет ревизию при первом открытии; сворачивание не обновляет базу черновика.
   */
  const handleTransition = (mode: "complete" | "cancel") => {
    if (!hasOutcomeDraft && draftError === null) {
      outcomeForm.setFieldValue("revision", plan.revision);
    }
    setError(null);
    setTransitionMode(mode);
  };

  /**
   * Явно отбрасывает итог и позволяет начать ввод по актуальной ревизии плана.
   */
  const handleDiscardOutcome = () => {
    const values = { result: plan.result, revision: plan.revision };
    outcomeForm.setValues(values);
    outcomeForm.resetDirty(values);
    outcomeForm.clearErrors();
    removeSessionStored(outcomeKey);
    setHasOutcomeDraft(false);
    setDraftError(null);
    setCanPersistOutcome(true);
    setError(null);
    void refresh().catch(() => undefined);
  };

  /**
   * Фиксирует итог только после повторной серверной проверки состава.
   */
  const handleOutcome = async (values: typeof outcomeForm.values) => {
    if (draftError !== null) return;
    const action = transitionMode === "cancel" ? "cancel" : "complete";
    try {
      await transitionPlan(projectId, plan.id, values.revision, action, values.result);
      shouldFocusClosed.current = true;
      void refresh().catch(() => undefined);
      removeSessionStored(outcomeKey);
      setHasOutcomeDraft(false);
      setError(null);
      setTransitionMode(null);
    } catch (error) {
      if (error instanceof PlanningError) setError(error.message);
      else throw error;
    }
  };

  const headerDescription = hasSummary ? (
    <span className={styles.summary}>{plan.summary}</span>
  ) : undefined;
  const finishDescriptionId = isActionDisabled ? actionHintId : undefined;
  const headerActions = canEdit ? (
    <>
      <Button
        variant="default"
        leftSection={<Pencil size={16} aria-hidden="true" />}
        onClick={onEdit}
      >
        Изменить
      </Button>
      <Tooltip label={actionHint} disabled={!isActionDisabled}>
        <Button
          data-disabled={isActionDisabled || undefined}
          aria-disabled={isActionDisabled || undefined}
          aria-describedby={finishDescriptionId}
          leftSection={<Check size={16} aria-hidden="true" />}
          onClick={(event) => {
            if (isActionDisabled) {
              event.preventDefault();
              return;
            }
            handleTransition("complete");
          }}
        >
          Завершить план
        </Button>
      </Tooltip>
      <Menu position="bottom-end">
        <Menu.Target>
          <ActionIcon aria-label="Другие действия с планом" variant="default" size={36}>
            <MoreHorizontal size={18} aria-hidden="true" />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            color="danger"
            leftSection={<Ban size={16} aria-hidden="true" />}
            onClick={() => handleTransition("cancel")}
          >
            Отменить план
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </>
  ) : undefined;

  return (
    <>
      <Anchor component={Link} to={`${basePath}/plans`} className={styles.back}>
        <ArrowLeft size={16} aria-hidden="true" />
        Все планы
      </Anchor>
      <PageHeader
        title={plan.title}
        titleRef={headingRef}
        meta={
          <>
            <span className={styles.key}>{plan.key}</span>
            <StatusBadge tone={PLAN_STATUS_TONES[plan.status]}>{statusLabel}</StatusBadge>
            {hasDivergence && <StatusBadge tone="warning">Состав изменился</StatusBadge>}
          </>
        }
        description={headerDescription}
        actionsLayout="inline"
        actions={headerActions}
      />
      <div className={styles.mobileProgress}>
        <Progress
          variant="accent"
          value={summaryData.percent}
          className={styles.mobileTrack}
          aria-label={progressLabel}
        />
        <a href="#plan-summary" className={styles.mobileLink}>
          {summaryData.done} из {summaryData.total} задач · {summaryData.percent}%
        </a>
      </div>
      {hasError && (
        <Alert
          color="danger"
          title="Изменение не сохранено"
          withCloseButton
          closeButtonLabel="Скрыть сообщение"
          onClose={() => setError(null)}
        >
          {error}
        </Alert>
      )}
      {hasDivergence && (
        <Alert color="warning" title="Состав изменился после завершения">
          Сохранённый итог остаётся историческим фактом. Текущие обязательства задач больше не
          выполнены; подробности доступны в задачах этапов.
        </Alert>
      )}

      <div className={styles.layout}>
        <div className={styles.main}>
          <SectionPanel title="Цель плана">
            <MarkdownView
              text={plan.goal}
              compact
              emptyText="Сформулируйте результат, ради которого начинается работа."
            />
          </SectionPanel>
          <Tabs value={activeTab} onChange={handleTab} className={styles.workspace}>
            <Tabs.List aria-label="Содержание плана" className={styles.tabs}>
              <Tabs.Tab value="stages" leftSection={<Layers3 size={16} aria-hidden="true" />}>
                Этапы и задачи
                <span className={styles.tabCount}>
                  <VisuallyHidden>, этапов: </VisuallyHidden>
                  {plan.stageCount}
                </span>
              </Tabs.Tab>
              <Tabs.Tab value="overview" leftSection={<FileText size={16} aria-hidden="true" />}>
                Материалы
              </Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="stages" pt="lg">
              <PlanStages plan={plan} />
            </Tabs.Panel>
            <Tabs.Panel value="overview" pt="lg">
              <PlanOverview plan={plan} />
            </Tabs.Panel>
          </Tabs>
          {hasResult && (
            <SectionPanel title={resultLabel}>
              <MarkdownView text={plan.result} compact />
            </SectionPanel>
          )}
        </div>

        <aside className={styles.aside} id="plan-summary" aria-label="Сводка плана">
          <SectionPanel title="Выполнение задач" density="compact" className={styles.summaryPanel}>
            <div className={styles.progressValue}>
              <strong>
                {summaryData.percent}
                <span>%</span>
              </strong>
              <span>
                {summaryData.done} из {summaryData.total} завершено
              </span>
            </div>
            <Progress variant="accent" value={summaryData.percent} aria-label={progressLabel} />
            <dl className={styles.counts}>
              <div>
                <dt>
                  <span className={styles.dot} data-state="done" aria-hidden="true" />
                  Готово
                </dt>
                <dd>{summaryData.done}</dd>
              </div>
              <div>
                <dt>
                  <span className={styles.dot} data-state="active" aria-hidden="true" />В работе
                </dt>
                <dd>{summaryData.active}</dd>
              </div>
              <div>
                <dt>
                  <span className={styles.dot} data-state="review" aria-hidden="true" />
                  На проверке
                </dt>
                <dd>{summaryData.review}</dd>
              </div>
              <div>
                <dt>
                  <span className={styles.dot} aria-hidden="true" />
                  Остальные
                </dt>
                <dd>{otherCount}</dd>
              </div>
            </dl>
            {hasBlockers && (
              <p className={styles.blocker}>
                <CircleAlert size={16} aria-hidden="true" />
                <span>
                  Невыполненные обязательства: {summaryData.blocked}
                  <small>Подробности — в задачах этапов</small>
                </span>
              </p>
            )}
            {canEdit && isActionDisabled && (
              <p className={styles.finishHint} id={actionHintId}>
                {actionHint}
              </p>
            )}
            {canEdit && canFinish && (
              <p className={styles.finishReady}>
                <Check size={16} aria-hidden="true" />
                Состав выполнен — план можно завершить.
              </p>
            )}
            <p className={styles.updated}>Обновлён {dateLabel}</p>
          </SectionPanel>
        </aside>
      </div>
      <Modal
        attributes={{ header: { role: "presentation" } }}
        opened={isTransitionOpen}
        onClose={() => setTransitionMode(null)}
        title={transitionTitle}
        size="lg"
        closeButtonProps={{ "aria-label": "Свернуть подтверждение" }}
      >
        <form
          className={styles.form}
          onSubmit={outcomeForm.onSubmit(handleOutcome, () =>
            outcomeForm.getInputNode("result")?.focus(),
          )}
        >
          <p className={styles.hint}>
            Состояние и итог сохранятся в проекте. Готовность повторно проверит сервер.
          </p>
          {hasDraftError && (
            <Alert color="warning" title="Проверьте черновик итога">
              {draftError}
              <Button size="xs" variant="subtle" onClick={handleDiscardOutcome}>
                Отбросить черновик и перечитать
              </Button>
            </Alert>
          )}
          <MarkdownField
            label={outcomeLabel}
            required
            disabled={outcomeForm.submitting}
            key={outcomeForm.key("result")}
            {...outcomeForm.getInputProps("result")}
          />
          {!canPersistOutcome && (
            <Alert color="warning">
              Черновик итога не сохранился в браузере. Не закрывайте страницу до сохранения плана.
            </Alert>
          )}
          {hasError && (
            <Alert color="danger" title="Итог не сохранён">
              {error}
              <Button size="xs" variant="subtle" onClick={handleDiscardOutcome}>
                Отбросить итог и перечитать
              </Button>
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setTransitionMode(null)}>
              Свернуть
            </Button>
            <Button type="submit" loading={outcomeForm.submitting} disabled={hasDraftError}>
              {transitionTitle}
            </Button>
          </Group>
        </form>
      </Modal>
    </>
  );
};
