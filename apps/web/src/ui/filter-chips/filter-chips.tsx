import clsx from "clsx";
import { isDefined } from "shared/value-predicates";
import type { FilterChipsProps } from "./types/filter-chips-props.type";
import styles from "./styles/filter-chips.module.css";

/**
 * Показывает один выбранный вариант из короткого набора кнопками-«пилюлями» с числом.
 * Выбор объявляется через aria-pressed; варианты переносятся и не уходят за край.
 *
 * Используется для:
 *  - фильтра каталога по состоянию записи (планы, релизы)
 */
export const FilterChips = <Value extends string>(props: FilterChipsProps<Value>) => {
  const { label, options, value, onChange, className, ...rootAttrs } = props;
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={styles.chip}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {isDefined(option.count) && <span className={styles.count}>{option.count}</span>}
        </button>
      ))}
    </div>
  );
};
