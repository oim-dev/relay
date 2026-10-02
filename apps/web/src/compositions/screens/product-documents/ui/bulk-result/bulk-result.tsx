import { useEffect, useId, useRef } from "react";
import clsx from "clsx";
import { CloseButton } from "@mantine/core";
import { isNonEmptyArray } from "shared/value-predicates";
import type { BulkResultProps } from "./types/bulk-result-props.type";
import styles from "./styles/bulk-result.module.css";

/**
 * Сообщает фактический результат массового действия: сколько сохранено и что не применено с причинами.
 * Неприменённые материалы остаются выбранными для осознанного повтора; автоматического повтора нет.
 *
 * Используется для:
 *  - разбора частичного отказа после массового изменения каталога
 */
export const BulkResult = (props: BulkResultProps) => {
  const { outcome, retryCount, onDismiss, className, ...rootAttrs } = props;
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const isFailed = outcome.requestError !== null;
  const hasRemainder = isNonEmptyArray(outcome.remainder);
  const tone = isFailed || hasRemainder ? "warning" : "success";
  const summary = isFailed
    ? "Запрос не выполнен. Список перечитан — проверьте состояние перед повтором."
    : `Сохранено ${outcome.applied} из ${outcome.total}` +
      (outcome.unchanged > 0 ? `, без изменений ${outcome.unchanged}` : "") +
      (hasRemainder ? `, не применено ${outcome.remainder.length}.` : ".");
  const retryNote =
    retryCount > 0
      ? `Неприменённые материалы (${retryCount}) остались выбранными: проверьте их и повторите действие при необходимости.`
      : "";
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: false });
  }, [outcome]);
  return (
    <section
      {...rootAttrs}
      className={clsx(styles.root, className)}
      data-tone={tone}
      aria-labelledby={titleId}
    >
      <header className={styles.header}>
        <h3 id={titleId} ref={headingRef} tabIndex={-1} className={styles.title}>
          {outcome.action}
        </h3>
        <CloseButton size="sm" aria-label="Скрыть результат" onClick={onDismiss} />
      </header>
      <p className={styles.summary} role="status">
        {summary}
      </p>
      {isFailed && <p className={styles.summary}>{outcome.requestError}</p>}
      {hasRemainder && (
        <ul className={styles.list} aria-label="Не применено">
          {outcome.remainder.map((item) => (
            <li key={item.id} className={styles.item}>
              <span className={styles.name}>{item.title}</span>
              <span className={styles.reason}>{item.reason}</span>
            </li>
          ))}
        </ul>
      )}
      {retryCount > 0 && <p className={styles.note}>{retryNote}</p>}
    </section>
  );
};
