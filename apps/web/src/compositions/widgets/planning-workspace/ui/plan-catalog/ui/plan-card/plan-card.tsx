import { Link } from "react-router-dom";
import { Badge, Progress } from "@mantine/core";
import { ArrowUpRight, Ban, Check, CircleAlert, CircleDashed, Flag, Layers3 } from "lucide-react";
import { getPlanSummary, PLAN_STATUS_COLORS, PLAN_STATUS_LABELS } from "domains/planning";
import type { PlanCardProps } from "./types/plan-card-props.type";
import styles from "./styles/plan-card.module.css";

/**
 * Показывает цель, собственный прогресс и ближайший этап плана.
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
  const href = `${basePath}/plans/${plan.id}`;
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
  const progressLabel = "Выполнение задач";
  const progressColor = hasDivergence ? "orange" : isCompleted ? "teal" : "var(--tasks-muted)";
  const stageItems = plan.stagePreview;

  return (
    <article className={styles.root}>
      <div className={styles.topline}>
        <span className={styles.type}>
          <Flag size={14} aria-hidden="true" />
          План работ
        </span>
        <Badge
          size="sm"
          variant="light"
          color={PLAN_STATUS_COLORS[plan.status]}
          className={styles.badge}
        >
          {statusLabel}
        </Badge>
      </div>
      <h2 className={styles.title}>
        <Link to={href} className={styles.link}>
          {plan.title}
          <ArrowUpRight size={17} className={styles.arrow} aria-hidden="true" />
        </Link>
      </h2>
      <p className={styles.summary}>{plan.summary}</p>
      <div className={styles.progress}>
        <div className={styles.progressLabel}>
          <span>{progressLabel}</span>
          <strong>
            {summaryData.done}
            <span> / {summaryData.total}</span>
            <span className={styles.percent}>{summaryData.percent}%</span>
          </strong>
        </div>
        <Progress
          value={summaryData.percent}
          size={4}
          color={progressColor}
          aria-label={`${progressLabel}: ${summaryData.done} из ${summaryData.total}`}
        />
      </div>
      <div className={styles.next}>
        <StageIcon size={13} aria-hidden="true" />
        <span>
          {nextPrefix}
          {nextLabel}
        </span>
      </div>
      <footer className={styles.footer}>
        <span className={styles.key}>{plan.key}</span>
        <span className={styles.stageCount}>
          <Layers3 size={12} aria-hidden="true" />
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
