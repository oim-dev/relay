import { useEffect, useId, useRef } from "react";
import clsx from "clsx";
import { Button, CloseButton } from "@mantine/core";
import { RefreshCw } from "lucide-react";
import { isNonEmptyArray } from "shared/value-predicates";
import type { BulkOutcome } from "../../types/bulk.type";
import type { BulkResultProps } from "./types/bulk-result-props.type";
import styles from "./styles/bulk-result.module.css";

/** Итог действия по квитанции сервера. */
const getReceiptSummary = (outcome: Extract<BulkOutcome, { kind: "receipt" }>): string =>
  `Сохранено ${outcome.applied} из ${outcome.total}` +
  (outcome.unchanged > 0 ? `, без изменений ${outcome.unchanged}` : "") +
  (isNonEmptyArray(outcome.remainder) ? `, не применено ${outcome.remainder.length}.` : ".");

/** Итог действия для каждого вида исхода. */
const getSummary = (outcome: BulkOutcome): string => {
  if (outcome.kind === "receipt") return getReceiptSummary(outcome);
  if (outcome.kind === "rejected") return "Сервер отклонил запрос: изменения не применены.";
  return "Результат операции неизвестен: ответ сервера не получен или не прочитан. Изменения могли сохраниться. Проверьте текущее состояние перед повтором.";
};

/** Пояснение о материалах, оставшихся выбранными. */
const getRetryNote = (outcome: BulkOutcome, count: number): string => {
  if (count === 0) return "";
  if (outcome.kind === "receipt")
    return `Неприменённые материалы (${count}) остались выбранными: проверьте их и повторите действие при необходимости.`;
  if (outcome.kind === "rejected")
    return `Выбор сохранён (${count}): устраните причину и повторите действие.`;
  return `Материалы (${count}) остались выбранными с прежними ревизиями: если изменения сохранились, повтор будет отклонён как конфликт и не перезапишет их.`;
};

/**
 * Сообщает фактический результат массового действия: квитанцию с исходом каждого материала,
 * отказ всего запроса или неизвестный исход, когда ответ о записи не получен.
 * Выбор сохраняется для осознанного повтора; автоматического повтора нет.
 *
 * Используется для:
 *  - разбора частичного отказа после массового изменения каталога
 *  - проверки состояния, когда ответ сервера о записи потерян
 */
export const BulkResult = (props: BulkResultProps) => {
  const { outcome, onDismiss, onRefresh, isRefreshing, className, ...rootAttrs } = props;
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const remainder = outcome.kind === "receipt" ? outcome.remainder : [];
  const unknownItems = outcome.kind === "unknown" ? outcome.items : [];
  const tone = outcome.kind === "receipt" && remainder.length === 0 ? "success" : "warning";
  const retryNote = getRetryNote(outcome, outcome.kept);
  const canRefresh = outcome.kind !== "receipt" && onRefresh !== undefined;
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
        {getSummary(outcome)}
      </p>
      {outcome.kind === "rejected" && <p className={styles.summary}>{outcome.message}</p>}
      {isNonEmptyArray(remainder) && (
        <ul className={styles.list} aria-label="Не применено">
          {remainder.map((item) => (
            <li key={item.id} className={styles.item}>
              <span className={styles.name}>{item.title}</span>
              <span className={styles.reason}>{item.reason}</span>
            </li>
          ))}
        </ul>
      )}
      {isNonEmptyArray(unknownItems) && (
        <ul className={styles.list} aria-label="Результат неизвестен">
          {unknownItems.map((item) => (
            <li key={item.id} className={styles.item}>
              <span className={styles.name}>{item.title}</span>
              <span className={styles.reason}>результат неизвестен</span>
            </li>
          ))}
        </ul>
      )}
      {retryNote !== "" && <p className={styles.note}>{retryNote}</p>}
      {canRefresh && (
        <div className={styles.actions}>
          <Button
            size="xs"
            variant="default"
            radius="xl"
            leftSection={<RefreshCw size={13} aria-hidden="true" />}
            loading={isRefreshing}
            onClick={onRefresh}
          >
            Перечитать список
          </Button>
        </div>
      )}
    </section>
  );
};
