import { MetricBlocker } from "../metric-blocker/metric-blocker";
import { MetricBoard } from "../metric-board/metric-board";
import { MetricPlan } from "../metric-plan/metric-plan";
import { MetricTask } from "../metric-task/metric-task";
import { ReleaseItem } from "../release-summaries/ui/release-item/release-item";
import type { MetricEntryProps } from "./types/metric-entry-props.type";
import styles from "./styles/metric-entry.module.css";

/**
 * Выбирает отображение записи показателя по её виду: задача, затронутая задача,
 * блокер, доска, план или релиз. Собственного DOM не создаёт.
 *
 * Используется для:
 *  - единого списка подборки и полного чтения любого показателя оператора
 */
export const MetricEntry = (props: MetricEntryProps) => {
  const { entry, snapshotVersion, boardScale, shouldShowColumn, basePath } = props;
  switch (entry.kind) {
    case "task":
    case "affected":
      return <MetricTask entry={entry} shouldShowColumn={shouldShowColumn} basePath={basePath} />;
    case "blocker":
      return <MetricBlocker entry={entry} snapshotVersion={snapshotVersion} basePath={basePath} />;
    case "board":
      return <MetricBoard entry={entry} scale={boardScale} basePath={basePath} />;
    case "plan":
      return <MetricPlan entry={entry} basePath={basePath} />;
    case "release":
      return <ReleaseItem release={entry.release} basePath={basePath} className={styles.release} />;
  }
};
