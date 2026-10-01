import { useRef } from "react";
import clsx from "clsx";
import { Button } from "@mantine/core";
import { RefreshCw } from "lucide-react";
import { isDefined, isNonEmptyArray } from "shared/value-predicates";
import { useEntryFocus } from "./hooks/use-entry-focus.hook";
import type { MetricFrameProps } from "./types/metric-frame-props.type";
import styles from "./styles/metric-frame.module.css";

/**
 * Показывает записи метрики одним списком с состоянием чтения: ход загрузки,
 * число показанных из полного, продолжение, отказ и повтор. Записи с прежним ID
 * при обновлении остаются теми же элементами, поэтому фокус и прокрутка сохраняются;
 * если запись с фокусом исчезла, фокус переходит на запись, вставшую на её место.
 *
 * Используется для:
 *  - подборок и полных списков показателей оператора
 *  - затронутых задач одного блокера
 */
export const MetricFrame = (props: MetricFrameProps) => {
  const {
    label,
    entryIds,
    children,
    focusFallbackRef,
    isBusy = false,
    statusText = null,
    loadedNote = null,
    emptyText = null,
    error = null,
    hasMore = false,
    isLoadingMore = false,
    onMore,
    onRetry,
    className,
    ...rootAttrs
  } = props;
  const listRef = useRef<HTMLUListElement>(null);
  useEntryFocus(listRef, entryIds, focusFallbackRef);
  const canRetry = isDefined(error) && error.canRetry && isDefined(onRetry);
  const shouldShowMore = hasMore && isDefined(onMore) && !isDefined(error);
  const isEmpty = !isNonEmptyArray(entryIds) && isDefined(emptyText);
  const updateMark = error?.isUpdate === true ? "" : undefined;
  const errorRole = error?.isUpdate === true ? "status" : "alert";
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)} aria-busy={isBusy}>
      <ul ref={listRef} className={styles.list} aria-label={label}>
        {children}
      </ul>
      {isEmpty && <p className={styles.note}>{emptyText}</p>}
      {isDefined(statusText) && (
        <p className={styles.note} role="status">
          {statusText}
        </p>
      )}
      {isDefined(loadedNote) && <p className={styles.note}>{loadedNote}</p>}
      {isDefined(error) && (
        <div className={styles.error} data-update={updateMark} role={errorRole}>
          <p>{error.text}</p>
          {canRetry && (
            <Button
              size="compact-sm"
              variant="default"
              leftSection={<RefreshCw size={14} aria-hidden="true" />}
              onClick={onRetry}
            >
              Перечитать список
            </Button>
          )}
        </div>
      )}
      {shouldShowMore && (
        <Button
          size="compact-sm"
          variant="subtle"
          className={styles.more}
          loading={isLoadingMore}
          onClick={onMore}
        >
          Загрузить ещё
        </Button>
      )}
    </div>
  );
};
