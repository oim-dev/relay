import { useId } from "react";
import clsx from "clsx";
import { MetricDisclosure } from "../../../metric-disclosure/metric-disclosure";
import type { ReleasePreparationProps } from "./types/release-preparation-props.type";
import styles from "./styles/release-preparation.module.css";

/**
 * Показывает два самостоятельных показателя подготовки выпуска: запланированные релизы
 * с готовым составом и готовые завершённые планы, ещё не включённые в запланированный
 * или выпущенный релиз. Чтение не меняет статусы планов и релизов.
 *
 * Используется для:
 *  - решения, что можно готовить к выпуску и что ещё не включено
 */
export const ReleasePreparation = (props: ReleasePreparationProps) => {
  const { preparation, snapshotVersion, basePath, className, ...rootAttrs } = props;
  const { readyReleases, completedPlansOutsideReleases } = preparation;
  const headingId = useId();
  return (
    <section {...rootAttrs} className={clsx(styles.root, className)} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.title}>
        Подготовка выпуска
      </h3>
      <MetricDisclosure
        title="Запланированные релизы с готовым составом"
        headingLevel={4}
        variant="plain"
        hint="Можно рассмотреть явную фиксацию выпуска; это не подтверждение CI или публикации."
        request={{ metric: "ready-releases" }}
        preview={{
          total: readyReleases.total,
          hasMore: readyReleases.hasMore,
          entries: readyReleases.items.map((release) => ({
            kind: "release",
            id: release.id,
            release,
          })),
        }}
        emptyText="Нет запланированных релизов с полностью готовым составом."
        snapshotVersion={snapshotVersion}
        basePath={basePath}
      />
      <MetricDisclosure
        title="Готовые завершённые планы вне релизов"
        headingLevel={4}
        variant="plain"
        hint="Завершённые планы с выполненным составом, которых нет ни в запланированном, ни в выпущенном релизе."
        request={{ metric: "plans-outside-releases" }}
        preview={{
          total: completedPlansOutsideReleases.total,
          hasMore: completedPlansOutsideReleases.hasMore,
          entries: completedPlansOutsideReleases.items.map((plan) => ({
            kind: "plan",
            id: plan.id,
            plan,
          })),
        }}
        emptyText="Все готовые завершённые планы уже включены в релизы."
        snapshotVersion={snapshotVersion}
        basePath={basePath}
      />
    </section>
  );
};
