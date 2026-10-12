import { useState } from "react";
import { Link } from "react-router-dom";
import { Alert, Anchor, Button, Progress, Skeleton, VisuallyHidden } from "@mantine/core";
import { Pencil } from "lucide-react";
import { PLAN_STATUS_LABELS, PLAN_STATUS_TONES } from "domains/planning";
import { useReleasePlans, getReleaseSummary } from "domains/releases";
import { useProjectId } from "domains/project";
import { MarkdownView } from "ui/markdown-view";
import { SectionPanel } from "ui/section-panel";
import { StatePanel } from "ui/state-panel";
import { StatusBadge } from "ui/status-badge";
import type { StatusBadgeTone } from "ui/status-badge";
import { isDefined, isEmptyArray } from "shared/value-predicates";
import type { ReleaseContentProps } from "./types/release-content-props.type";
import styles from "./styles/release-content.module.css";

/**
 * Показывает готовность самостоятельных планов, включённых в выпуск.
 * У каждого плана раздельно видны собственное состояние и фактическое выполнение состава:
 * выпуску мешает план, который ещё не завершён или чей состав не выполнен.
 *
 * Используется для:
 *  - чтения актуальных планов самостоятельного релиза
 */
export const ReleaseContent = (props: ReleaseContentProps) => {
  const { release, basePath, onEdit } = props;
  const projectId = useProjectId();
  const [limit, setLimit] = useState(12);
  const query = useReleasePlans(projectId, release.id, limit);
  const summary = query.data?.readiness ?? getReleaseSummary(release);
  const planItems = (query.data?.items ?? []).map((plan) => {
    const executionLabel = plan.isMissing
      ? null
      : plan.total === 0
        ? "Задач в составе нет"
        : plan.isReady
          ? "Состав выполнен"
          : "Состав не выполнен";
    // Завершённый план с невыполненным составом — расхождение, которое мешает выпуску.
    const executionTone: StatusBadgeTone = plan.isReady
      ? "success"
      : plan.status === "completed"
        ? "warning"
        : "neutral";
    return {
      ...plan,
      canOpen: !plan.isMissing,
      href: `${basePath}/plans/${encodeURIComponent(plan.id)}`,
      hasContent: plan.goal.trim() !== "" || plan.result.trim() !== "",
      hasSummary: plan.summary.trim() !== "",
      statusLabel: isDefined(plan.status) ? PLAN_STATUS_LABELS[plan.status] : "Недоступен",
      statusTone: isDefined(plan.status) ? PLAN_STATUS_TONES[plan.status] : ("warning" as const),
      executionLabel,
      executionTone,
      progressLabel: `Выполнено задач плана: ${plan.done} из ${plan.total}`,
    };
  });
  const hasData = isDefined(query.data);
  const hasReadError = isDefined(query.error);
  const isEmpty = hasData && isEmptyArray(planItems);
  const canEdit = release.status !== "released";
  const hasMore = isDefined(query.data?.nextOffset);
  const panelActions = canEdit ? (
    <Button
      variant="default"
      size="xs"
      leftSection={<Pencil size={16} aria-hidden="true" />}
      onClick={onEdit}
    >
      Изменить состав
    </Button>
  ) : undefined;
  const emptyAction = canEdit ? (
    <Button variant="default" onClick={onEdit}>
      Изменить состав
    </Button>
  ) : undefined;
  return (
    <SectionPanel
      title="Планы релиза"
      count={
        <>
          <VisuallyHidden>Планов: </VisuallyHidden>
          {summary.total}
        </>
      }
      description={`Готово планов сейчас: ${summary.ready} из ${summary.total}. Показаны актуальные состояния планов и выполнение их задач.`}
      actions={panelActions}
    >
      {query.isLoading && (
        <div className={styles.list} role="status" aria-label="Загружаем состав">
          <Skeleton height={120} radius="xl" />
          <Skeleton height={120} radius="xl" />
        </div>
      )}
      {hasReadError && hasData && (
        <Alert color="warning" title="Не удалось обновить состав">
          Показан последний прочитанный состав. {query.error?.message}
          <Button size="xs" variant="subtle" onClick={() => void query.mutate()}>
            Повторить чтение
          </Button>
        </Alert>
      )}
      {hasReadError && !hasData && (
        <StatePanel
          state="error"
          title="Состав релиза не прочитан"
          description={query.error?.message ?? "Сервер не ответил на запрос состава."}
          action={
            <Button variant="default" onClick={() => void query.mutate()}>
              Повторить чтение
            </Button>
          }
        />
      )}
      {isEmpty && (
        <StatePanel
          title="Выберите результаты для выпуска"
          description="Добавьте планы работ. Их задачи останутся на своих местах."
          action={emptyAction}
        />
      )}
      {!isEmptyArray(planItems) && (
        <ul className={styles.list}>
          {planItems.map((included) => (
            <li key={included.id} className={styles.plan}>
              <div className={styles.planHeader}>
                <span className={styles.key}>{included.key}</span>
                <span className={styles.badges}>
                  <StatusBadge tone={included.statusTone}>
                    <VisuallyHidden>Состояние плана: </VisuallyHidden>
                    {included.statusLabel}
                  </StatusBadge>
                  {isDefined(included.executionLabel) && (
                    <StatusBadge tone={included.executionTone}>
                      {included.executionLabel}
                    </StatusBadge>
                  )}
                </span>
              </div>
              <h3 className={styles.planTitle}>
                {included.canOpen && (
                  <Anchor component={Link} to={included.href}>
                    {included.title}
                  </Anchor>
                )}
                {!included.canOpen && included.title}
              </h3>
              {included.hasSummary && <p className={styles.summary}>{included.summary}</p>}
              {included.canOpen && (
                <div className={styles.progress}>
                  <Progress
                    variant="accent"
                    value={included.percent}
                    className={styles.track}
                    aria-label={included.progressLabel}
                  />
                  <span>
                    {included.done} из {included.total} задач
                  </span>
                </div>
              )}
              {included.hasContent && (
                <details className={styles.planContent}>
                  <summary>Цель и итог плана</summary>
                  <div className={styles.planContentBody}>
                    <MarkdownView text={included.goal} compact />
                    <MarkdownView text={included.result} compact emptyText="Итог не указан." />
                  </div>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      {hasMore && (
        <Button
          variant="default"
          className={styles.more}
          loading={query.isValidating}
          onClick={() => setLimit(limit + 12)}
        >
          Показать ещё · {planItems.length} из {query.data?.total}
        </Button>
      )}
    </SectionPanel>
  );
};
