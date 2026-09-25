import { useState } from "react";
import { Link } from "react-router-dom";
import { Alert, Badge, Button, Progress } from "@mantine/core";
import { ArrowUpRight, CheckCircle2, Flag, Pencil, Rocket } from "lucide-react";
import { PLAN_STATUS_LABELS, PLAN_STATUS_COLORS } from "domains/planning";
import { useReleasePlans, getReleaseSummary } from "domains/releases";
import { useProjectId } from "domains/project";
import { MarkdownView } from "ui/markdown-view";
import { isDefined, isEmptyArray } from "shared/value-predicates";
import type { ReleaseContentProps } from "./types/release-content-props.type";
import styles from "./styles/release-content.module.css";

/**
 * Показывает готовность самостоятельных планов, включённых в выпуск.
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
  const planItems = (query.data?.items ?? []).map((plan) => ({
    ...plan,
    canOpen: !plan.isMissing,
    hasContent: plan.goal.trim() !== "" || plan.result.trim() !== "",
    statusLabel: isDefined(plan.status) ? PLAN_STATUS_LABELS[plan.status] : "Недоступен",
    statusColor: isDefined(plan.status) ? PLAN_STATUS_COLORS[plan.status] : "gray",
  }));
  const hasReadError = isDefined(query.error);
  const isEmpty = !query.isLoading && !hasReadError && isEmptyArray(planItems);
  const canEdit = release.status !== "released";
  const hasMore = isDefined(query.data?.nextOffset);
  return (
    <div className={styles.root}>
      <div className={styles.heading}>
        <div>
          <h2>Планы релиза</h2>
          <p>Показаны актуальные планы и выполнение их задач.</p>
        </div>
        {canEdit && (
          <Button variant="default" size="xs" leftSection={<Pencil size={13} />} onClick={onEdit}>
            Изменить состав
          </Button>
        )}
      </div>
      <div className={styles.readiness}>
        <CheckCircle2 size={17} />
        <strong>
          {summary.ready} из {summary.total}
        </strong>
        <span>планов готовы сейчас</span>
      </div>
      {query.isLoading && <p role="status">Загружаем состав…</p>}
      {hasReadError && (
        <Alert color="red">
          {query.error?.message}
          <Button size="xs" variant="subtle" onClick={() => void query.mutate()}>
            Повторить
          </Button>
        </Alert>
      )}
      {isEmpty && (
        <div className={styles.empty}>
          <Rocket size={26} strokeWidth={1.3} />
          <h3>Выберите результаты для выпуска</h3>
          <p>Добавьте планы работ. Их задачи останутся на своих местах.</p>
        </div>
      )}
      {planItems.map((included) => (
        <article key={included.id} className={styles.plan}>
          <div className={styles.planHeader}>
            <span className={styles.key}>
              <Flag size={13} />
              {included.key}
            </span>
            <Badge size="sm" color={included.statusColor} variant="light" className={styles.badge}>
              {included.statusLabel}
            </Badge>
          </div>
          <h3 className={styles.planTitle}>{included.title}</h3>
          {included.canOpen && (
            <Link to={`${basePath}/plans/${included.id}`} className={styles.currentLink}>
              Открыть план
              <ArrowUpRight size={13} />
            </Link>
          )}
          <p className={styles.summary}>{included.summary}</p>
          {included.canOpen && (
            <div className={styles.progress}>
              <Progress
                value={included.percent}
                size={4}
                color="teal"
                className={styles.track}
                aria-label={`Завершено ${included.done} из ${included.total}`}
              />
              <span>
                {included.done} / {included.total} задач
              </span>
            </div>
          )}
          {included.hasContent && (
            <details className={styles.planContent}>
              <summary>Цель и результат плана</summary>
              <MarkdownView text={included.goal} compact />
              <MarkdownView text={included.result} compact emptyText="Итог не указан." />
            </details>
          )}
        </article>
      ))}
      {hasMore && (
        <Button
          variant="default"
          fullWidth
          loading={query.isValidating}
          onClick={() => setLimit(limit + 12)}
        >
          Показать ещё · {planItems.length} из {query.data?.total}
        </Button>
      )}
    </div>
  );
};
