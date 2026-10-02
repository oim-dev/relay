import clsx from "clsx";
import { Check, X } from "lucide-react";
import type { PickerResultsProps } from "./types/picker-results-props.type";
import styles from "./styles/picker-results.module.css";

/**
 * Показывает, какие материалы прикреплены, а какие нет и почему. Повтор не выполняется
 * автоматически: неприменённые остаются выбранными или требуют нового решения.
 *
 * Используется для:
 *  - разбора частичного результата множественного прикрепления
 */
export const PickerResults = (props: PickerResultsProps) => {
  const { outcomes, className, ...rootAttrs } = props;
  const appliedCount = outcomes.filter((outcome) => outcome.status === "applied").length;
  const failedCount = outcomes.length - appliedCount;
  const heading = `Применено: ${appliedCount} · не применено: ${failedCount}`;
  const outcomeItems = outcomes.map((outcome) => ({
    ...outcome,
    isApplied: outcome.status === "applied",
  }));
  return (
    <section
      {...rootAttrs}
      className={clsx(styles.root, className)}
      role="status"
      aria-live="polite"
      aria-label="Итог прикрепления"
    >
      <p className={styles.heading}>{heading}</p>
      <ul className={styles.list}>
        {outcomeItems.map((outcome) => (
          <li key={outcome.id} className={styles.item} data-applied={outcome.isApplied}>
            {outcome.isApplied && <Check size={14} aria-label="применено" />}
            {!outcome.isApplied && <X size={14} aria-label="не применено" />}
            <span className={styles.title}>{outcome.title}</span>
            <span className={styles.message}>{outcome.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
};
