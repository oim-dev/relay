import { Link } from "react-router-dom";
import { Progress } from "@mantine/core";
import { Ban, Check, CircleAlert, CircleDashed, Layers3 } from "lucide-react";
import { getPlanSummary, PLAN_STATUS_LABELS, PLAN_STATUS_TONES } from "domains/planning";
import { StatusBadge } from "ui/status-badge";
import type { PlanCardProps } from "./types/plan-card-props.type";
import styles from "./styles/plan-card.module.css";

/**
 * Показывает цель, собственный прогресс и ближайший этап плана.
 * Собственное состояние плана и фактическое выполнение задач показаны раздельно.
 *
 * Используется для:
 *  - сравнения объёма работ без открытия подробностей
 */
export const PlanCard = (props: PlanCardProps) => {
  const { plan, basePath } = props;
  const summaryData = getPlanSummary(plan);
  const isCompleted = plan.status === "completed";
  const hasDivergence = isCompleted && !plan.isReady;
  const isCancelled = plan.status === "cancelled";
  const statusLabel = PLAN_STATUS_LABELS[plan.status];
  const href = `${basePath}/plans/${encodeURIComponent(plan.id)}`;
  const nextLabel = isCancelled
    ? "Работа отменена"
    : hasDivergence
      ? "Состав изменился после завершения"
      : isCompleted
        ? "Результат зафиксирован"
        : (plan.nextStageTitle ??
          (plan.stageCount === 0 ? "Добавьте первый этап" : "Состав готов к завершению"));
  const StageIcon = isCancelled
    ? Ban
    : hasDivergence
      ? CircleAlert
      : isCompleted
        ? Check
        : CircleDashed;
  const nextPrefix = isCompleted || isCancelled ? "" : "Далее: ";
  const progressLabel = `Выполнено задач: ${summaryData.done} из ${summaryData.total} (${summaryData.percent}%)`;
  const hasSummary = plan.summary.trim() !== "";
  const stageItems = plan.stagePreview;

  return (
    <article className={styles.root}>
      <div className={styles.topline}>
        <span className={styles.key}>{plan.key}</span>
        <StatusBadge tone={PLAN_STATUS_TONES[plan.status]}>{statusLabel}</StatusBadge>
      </div>
      <h3 className={styles.title}>
        <Link to={href} className={styles.link}>
          {plan.title}
        </Link>
      </h3>
      {hasSummary && <p className={styles.summary}>{plan.summary}</p>}
      <div className={styles.progress}>
        <Progress variant="accent" value={summaryData.percent} aria-label={progressLabel} />
        <p className={styles.progressLabel}>
          <span>Выполнено задач</span>
          <strong>
            {summaryData.done} из {summaryData.total}
            <span className={styles.percent}>{summaryData.percent}%</span>
          </strong>
        </p>
      </div>
      <p className={styles.next} data-warning={hasDivergence}>
        <StageIcon size={16} aria-hidden="true" />
        <span>
          {nextPrefix}
          {nextLabel}
        </span>
      </p>
      <footer className={styles.footer}>
        <span className={styles.stageCount}>
          <Layers3 size={14} aria-hidden="true" />
          Этапов: {plan.stageCount}
        </span>
        <span className={styles.stageDots} aria-hidden="true">
          {stageItems.map((stage) => (
            <span key={stage.id} className={styles.stageDot} data-done={stage.completed} />
          ))}
        </span>
      </footer>
    </article>
  );
};
