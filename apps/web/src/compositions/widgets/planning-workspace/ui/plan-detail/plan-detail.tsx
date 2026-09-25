import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ActionIcon as MantineActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Menu,
  Modal,
  Progress,
  Tabs,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import {
  ArrowLeft,
  Ban,
  Check,
  CircleAlert,
  FileText,
  Flag,
  Layers3,
  MoreHorizontal,
  Pencil,
  Target,
} from "lucide-react";
import { z } from "zod";
import {
  getPlanSummary,
  PLAN_STATUS_COLORS,
  PLAN_STATUS_LABELS,
  transitionPlan,
  usePlanningRefresh,
  PlanningError,
} from "domains/planning";
import { MarkdownView } from "ui/markdown-view";
import { MarkdownField } from "ui/markdown-field";
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
  const actionHint = "Завершение доступно после выполнения всего состава.";
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
  const resultLabel = isCancelled ? "ПРИЧИНА ОТМЕНЫ" : "ИТОГ ПЛАНА";
  const actionTitle = isActionDisabled ? actionHint : undefined;
  const isTransitionOpen = isDefined(transitionMode);
  const transitionTitle = transitionMode === "cancel" ? "Отменить план" : "Завершить план";
  const outcomeLabel =
    transitionMode === "cancel" ? "Почему работа отменена" : "Итог и подтверждение результата";

  useEffect(() => {
    document.title = `${plan.title} · Relay`;
    headingRef.current?.focus({ preventScroll: true });
  }, [plan.id, plan.title]);

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

  return (
    <div className={styles.root}>
      <Link to={`${basePath}/plans`} className={styles.back}>
        <ArrowLeft size={14} />
        Все планы
      </Link>
      <header className={styles.header}>
        <div className={styles.identity}>
          <div className={styles.meta}>
            <span className={styles.typeIcon}>
              <Flag size={16} />
            </span>
            <span className={styles.key}>{plan.key}</span>
            <Badge variant="light" color={PLAN_STATUS_COLORS[plan.status]} className={styles.badge}>
              {statusLabel}
            </Badge>
          </div>
          <h1 className={styles.title} ref={headingRef} tabIndex={-1}>
            {plan.title}
          </h1>
          <p className={styles.summary}>{plan.summary}</p>
        </div>
        <div className={styles.actions}>
          {canEdit && (
            <Button variant="default" leftSection={<Pencil size={14} />} onClick={onEdit}>
              Изменить
            </Button>
          )}
          {canEdit && (
            <Button
              disabled={isActionDisabled}
              title={actionTitle}
              leftSection={<Check size={14} />}
              onClick={() => handleTransition("complete")}
            >
              Завершить план
            </Button>
          )}
          {canEdit && (
            <Menu position="bottom-end">
              <Menu.Target>
                <MantineActionIcon
                  aria-label="Другие действия с планом"
                  variant="default"
                  size={36}
                >
                  <MoreHorizontal size={16} />
                </MantineActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  color="red"
                  leftSection={<Ban size={14} />}
                  onClick={() => handleTransition("cancel")}
                >
                  Отменить план
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          )}
        </div>
      </header>
      <div className={styles.mobileProgress}>
        <span>
          {summaryData.done} из {summaryData.total} задач
        </span>
        <Progress
          value={summaryData.percent}
          size={4}
          color="teal"
          className={styles.mobileTrack}
          aria-label={`Выполнение ${summaryData.percent}%`}
        />
        <a href="#plan-summary">Сводка · {summaryData.percent}%</a>
      </div>
      {hasError && (
        <Alert
          color="red"
          title="Изменение не сохранено"
          withCloseButton
          onClose={() => setError(null)}
        >
          {error}
        </Alert>
      )}
      {hasDivergence && (
        <Alert color="orange" title="Состав изменился после завершения" mb="md">
          Сохранённый итог остаётся историческим фактом. Текущие обязательства задач больше не
          выполнены; подробности доступны в задачах этапов.
        </Alert>
      )}

      <div className={styles.layout}>
        <div className={styles.main}>
          <section className={styles.goal}>
            <div className={styles.sectionLabel}>
              <Target size={15} />
              ЦЕЛЬ ПЛАНА
            </div>
            <MarkdownView
              text={plan.goal}
              compact
              emptyText="Сформулируйте результат, ради которого начинается работа."
            />
          </section>
          <Tabs
            value={activeTab}
            onChange={handleTab}
            classNames={{ list: styles.tabs, tab: styles.tab }}
          >
            <Tabs.List aria-label="Содержание плана">
              <Tabs.Tab value="stages" leftSection={<Layers3 size={14} />}>
                Этапы и задачи<span className={styles.tabCount}>{plan.stageCount}</span>
              </Tabs.Tab>
              <Tabs.Tab value="overview" leftSection={<FileText size={14} />}>
                Материалы и история
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
            <section className={styles.result}>
              <div className={styles.sectionLabel}>
                <Check size={15} />
                {resultLabel}
              </div>
              <MarkdownView text={plan.result} compact />
            </section>
          )}
        </div>

        <aside className={styles.aside} id="plan-summary" aria-label="Сводка плана">
          <section className={styles.progressPanel}>
            <h2 className={styles.asideTitle}>Выполнение задач</h2>
            <div className={styles.progressValue}>
              <strong>
                {summaryData.percent}
                <span>%</span>
              </strong>
              <span>
                {summaryData.done} из {summaryData.total} завершено
              </span>
            </div>
            <Progress
              value={summaryData.percent}
              size={5}
              color="teal"
              aria-label={`Завершено ${summaryData.done} из ${summaryData.total} задач`}
            />
            <dl className={styles.counts}>
              <div>
                <dt>
                  <span className={styles.dot} data-state="done" />
                  Готово
                </dt>
                <dd>{summaryData.done}</dd>
              </div>
              <div>
                <dt>
                  <span className={styles.dot} data-state="active" />В работе
                </dt>
                <dd>{summaryData.active}</dd>
              </div>
              <div>
                <dt>
                  <span className={styles.dot} data-state="review" />
                  На проверке
                </dt>
                <dd>{summaryData.review}</dd>
              </div>
              <div>
                <dt>
                  <span className={styles.dot} />
                  Остальные
                </dt>
                <dd>
                  {summaryData.total - summaryData.done - summaryData.active - summaryData.review}
                </dd>
              </div>
            </dl>
            {hasBlockers && (
              <div className={styles.blocker}>
                <CircleAlert size={15} />
                <span>
                  Невыполненные обязательства · {summaryData.blocked}
                  <small>Подробности — в задачах этапа</small>
                </span>
              </div>
            )}
          </section>
          <div className={styles.updated}>Обновлён {dateLabel}</div>
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
        <form onSubmit={outcomeForm.onSubmit(handleOutcome)}>
          <p className={styles.hint}>
            Состояние и итог сохранятся в проекте. Готовность повторно проверит сервер.
          </p>
          {hasDraftError && (
            <Alert color="orange" mb="md" title="Проверьте черновик итога">
              {draftError}
              <Button size="xs" variant="subtle" onClick={handleDiscardOutcome}>
                Отбросить черновик и перечитать
              </Button>
            </Alert>
          )}
          <MarkdownField
            label={outcomeLabel}
            disabled={outcomeForm.submitting}
            key={outcomeForm.key("result")}
            {...outcomeForm.getInputProps("result")}
          />
          {!canPersistOutcome && (
            <Alert color="orange" mt="md">
              Черновик итога не сохранился в браузере. Не закрывайте страницу до сохранения плана.
            </Alert>
          )}
          {hasError && (
            <Alert color="red" mt="md">
              {error}
              <Button size="xs" variant="subtle" onClick={handleDiscardOutcome}>
                Отбросить итог и перечитать
              </Button>
            </Alert>
          )}
          <Group justify="flex-end" mt="lg">
            <Button variant="default" onClick={() => setTransitionMode(null)}>
              Свернуть
            </Button>
            <Button type="submit" loading={outcomeForm.submitting} disabled={hasDraftError}>
              {transitionTitle}
            </Button>
          </Group>
        </form>
      </Modal>
    </div>
  );
};
