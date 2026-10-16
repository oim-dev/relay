import clsx from "clsx";
import { useId } from "react";
import { Button } from "@mantine/core";
import { useGetBranchPoints } from "domains/work-history";
import { isDefined, isNonEmptyArray } from "shared/value-predicates";
import { BranchPointItem } from "./ui/branch-point-item/branch-point-item";
import type { BranchPointsProps } from "./types/branch-points-props.type";
import styles from "./styles/branch-points.module.css";

/**
 * Открывает материалы любой точки текущей ветки независимо от загруженного окна графа.
 *
 * Используется для:
 *  - просмотра материалов и событий жизненного цикла одной ветки
 *  - явного продолжения списка и восстановления после ошибки чтения
 */
export const BranchPoints = (props: BranchPointsProps) => {
  const { projectId, sessionId, selectedPointId, onSelectPoint, className, ...rootAttrs } = props;
  const headingId = useId();
  const query = useGetBranchPoints(projectId, sessionId);
  const hasItems = isNonEmptyArray(query.items);
  const hasError = isDefined(query.error);
  const isEmpty = query.total === 0;
  const countLabel = query.total === null ? "" : `${query.items.length} из ${query.total}`;
  const statusLabel = query.isLoading
    ? "Читаем точки ветки…"
    : query.isRefreshing
      ? "Обновляем список…"
      : "";
  const isMoreDisabled = query.isRefreshing || hasError;
  const isCurrentOutsidePage =
    query.hasMore && !query.items.some((point) => point.id === selectedPointId);
  const pointsData = query.items.map((point) => ({
    point,
    isCurrent: point.id === selectedPointId,
  }));

  return (
    <section {...rootAttrs} className={clsx(styles.root, className)} aria-labelledby={headingId}>
      <div className={styles.heading}>
        <h3 id={headingId} className={styles.title}>
          Точки этой ветки
        </h3>
        <span className={styles.count}>{countLabel}</span>
      </div>
      <p className={styles.description}>Сначала новые</p>
      {isCurrentOutsidePage && (
        <p className={styles.description}>Открытая точка находится в более ранней части списка.</p>
      )}
      <span role="status" className={styles.status}>
        {statusLabel}
      </span>
      {hasError && (
        <div role="alert" className={styles.error}>
          <p>{query.error?.message}</p>
          <Button
            variant="default"
            size="xs"
            mih={44}
            onClick={query.refresh}
            disabled={query.isRefreshing}
          >
            Перечитать точки ветки
          </Button>
        </div>
      )}
      {isEmpty && <p className={styles.description}>В этой ветке пока нет сохранённых точек.</p>}
      {hasItems && (
        <div className={styles.scrollArea}>
          <ol className={styles.list} aria-label="Точки этой ветки">
            {pointsData.map(({ point, isCurrent }) => (
              <li key={point.id}>
                <BranchPointItem
                  point={point}
                  isCurrent={isCurrent}
                  onSelectPoint={onSelectPoint}
                />
              </li>
            ))}
          </ol>
        </div>
      )}
      {query.hasMore && (
        <Button
          variant="default"
          size="xs"
          mih={44}
          onClick={query.loadMore}
          disabled={isMoreDisabled}
        >
          Более ранние точки ветки
        </Button>
      )}
    </section>
  );
};
