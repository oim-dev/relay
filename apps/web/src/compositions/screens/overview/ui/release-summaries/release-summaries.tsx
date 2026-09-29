import clsx from "clsx";
import { RELEASE_STATUS_COUNT_LABELS } from "../../config/overview.config";
import { ReleaseGroup } from "./ui/release-group/release-group";
import type { ReleaseSummariesProps } from "./types/release-summaries-props.type";
import styles from "./styles/release-summaries.module.css";

/**
 * Показывает статусы релизов, ближайшие запланированные и последние выпущенные релизы.
 *
 * Используется для:
 *  - оценки выпусков проекта и фактической готовности их состава
 */
export const ReleaseSummaries = (props: ReleaseSummariesProps) => {
  const { releases, basePath, className, ...rootAttrs } = props;
  const statusItems = Object.entries(RELEASE_STATUS_COUNT_LABELS).map(([status, label]) => ({
    status,
    label,
    count: releases.byStatus[status as keyof typeof RELEASE_STATUS_COUNT_LABELS],
  }));
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <ul className={styles.statuses} aria-label="Релизы по статусам">
        {statusItems.map((item) => (
          <li key={item.status}>
            {item.label} <strong>{item.count}</strong>
          </li>
        ))}
      </ul>
      <ReleaseGroup
        title="Ближайшие"
        emptyText="Запланированных релизов нет."
        preview={releases.upcoming}
        basePath={basePath}
      />
      <ReleaseGroup
        title="Недавно выпущены"
        emptyText="Выпущенных релизов пока нет."
        preview={releases.recent}
        basePath={basePath}
      />
    </div>
  );
};
