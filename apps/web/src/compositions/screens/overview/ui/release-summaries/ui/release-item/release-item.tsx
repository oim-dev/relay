import clsx from "clsx";
import { Link } from "react-router-dom";
import { formatDateTime } from "infra/date-time";
import { isDefined } from "shared/value-predicates";
import { UNTITLED } from "../../../../config/overview.config";
import type { ReleaseItemProps } from "./types/release-item-props.type";
import styles from "./styles/release-item.module.css";

/** Показывает плановую дату YYYY-MM-DD без сдвига часового пояса. */
const formatPlannedDate = (date: string): string => date.split("-").reverse().join(".");

/**
 * Показывает релиз с версией, датой и фактической готовностью состава.
 *
 * Используется для:
 *  - перехода из обзора к релизу
 */
export const ReleaseItem = (props: ReleaseItemProps) => {
  const { release, basePath, className, ...rootAttrs } = props;
  const title = release.title === "" ? UNTITLED : release.title;
  const releasedLabel = isDefined(release.releasedAt)
    ? `Выпущен ${formatDateTime(release.releasedAt)}`
    : null;
  const plannedLabel = isDefined(release.plannedFor)
    ? `План: ${formatPlannedDate(release.plannedFor)}`
    : "Дата не задана";
  const dateLabel = releasedLabel ?? plannedLabel;
  const readinessLabel = `Готово планов: ${release.readiness.ready} из ${release.readiness.total}`;
  const canReleaseLabel =
    release.readiness.canRelease && !isDefined(release.releasedAt)
      ? "Состав готов к выпуску"
      : null;
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <Link to={`${basePath}/releases/${encodeURIComponent(release.id)}`} className={styles.link}>
        <span className={styles.version}>{release.version}</span>
        <span className={styles.title}>{title}</span>
      </Link>
      <p className={styles.meta}>
        <span>{dateLabel}</span>
        <span>{readinessLabel}</span>
        {isDefined(canReleaseLabel) && <span className={styles.ready}>{canReleaseLabel}</span>}
      </p>
    </div>
  );
};
