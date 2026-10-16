import clsx from "clsx";
import { isDefined } from "shared/value-predicates";
import type { StatusBadgeProps } from "./types/status-badge-props.type";
import styles from "./styles/status-badge.module.css";

/**
 * Показывает состояние записи короткой подписью в рамке смыслового тона.
 * Цвет дублирует подпись и не является единственным признаком состояния.
 *
 * Используется для:
 *  - состояния материала, плана, релиза и задачи в строках и карточках
 */
export const StatusBadge = (props: StatusBadgeProps) => {
  const { tone = "neutral", icon, children, className, ...rootAttrs } = props;
  return (
    <span {...rootAttrs} className={clsx(styles.root, className)} data-tone={tone}>
      {isDefined(icon) && (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      )}
      {children}
    </span>
  );
};
