import { Link } from "react-router-dom";
import { Progress } from "@mantine/core";
import { CalendarDays, Flag } from "lucide-react";
import {
  useReleasePlans,
  getReleaseSummary,
  RELEASE_STATUS_LABELS,
  RELEASE_STATUS_TONES,
} from "domains/releases";
import { useProjectId } from "domains/project";
import { StatusBadge } from "ui/status-badge";
import { isDefined } from "shared/value-predicates";
import type { ReleaseCardProps } from "./types/release-card-props.type";
import styles from "./styles/release-card.module.css";

/** Сколько планов состава показывает карточка. */
const PREVIEW_PLANS = 2;

/**
 * Различает собственный статус выпуска и готовность выбранных планов.
 *
 * Используется для:
 *  - просмотра версии, плановой даты и состава в каталоге релизов
 */
export const ReleaseCard = (props: ReleaseCardProps) => {
  const { release, basePath } = props;
  const projectId = useProjectId();
  const summary = getReleaseSummary(release);
  const composition = useReleasePlans(projectId, release.id, PREVIEW_PLANS);
  const planItems = composition.data?.items ?? [];
  const hasMorePlans = summary.total > PREVIEW_PLANS;
  const hasCompositionError = isDefined(composition.error);
  const isReleased = release.status === "released";
  const rawDate = isReleased ? release.releasedAt : release.plannedFor;
  const datePrefix = isReleased ? "Выпущен" : "План";
  const dateLabel = rawDate
    ? `${datePrefix}: ${new Intl.DateTimeFormat("ru", {
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(new Date(isReleased ? rawDate : `${rawDate}T12:00:00`))}`
    : "Дата не указана";
  const readinessLabel = `Готово планов: ${summary.ready} из ${summary.total}`;
  const hasSummary = release.summary.trim() !== "";
  return (
    <article className={styles.root}>
      <div className={styles.top}>
        <span className={styles.version}>{release.version}</span>
        <StatusBadge tone={RELEASE_STATUS_TONES[release.status]}>
          {RELEASE_STATUS_LABELS[release.status]}
        </StatusBadge>
      </div>
      <h3 className={styles.title}>
        <Link to={`${basePath}/releases/${encodeURIComponent(release.id)}`} className={styles.link}>
          {release.title}
        </Link>
      </h3>
      {hasSummary && <p className={styles.summary}>{release.summary}</p>}
      <ul className={styles.plans} aria-label="Планы релиза">
        {planItems.map((plan) => (
          <li key={plan.id}>
            <Flag size={14} aria-hidden="true" />
            <span>{plan.title}</span>
          </li>
        ))}
        {hasMorePlans && (
          <li className={styles.more}>Ещё планов: {summary.total - PREVIEW_PLANS}</li>
        )}
        {hasCompositionError && <li className={styles.more}>Состав временно недоступен</li>}
      </ul>
      <div className={styles.progress}>
        <Progress variant="accent" value={summary.percent} aria-label={readinessLabel} />
        <p className={styles.progressLabel}>
          <span>Готовность состава</span>
          <strong>
            {summary.ready} из {summary.total} планов
          </strong>
        </p>
      </div>
      <footer className={styles.footer}>
        <span className={styles.key}>{release.key}</span>
        <span className={styles.date}>
          <CalendarDays size={14} aria-hidden="true" />
          {dateLabel}
        </span>
      </footer>
    </article>
  );
};
