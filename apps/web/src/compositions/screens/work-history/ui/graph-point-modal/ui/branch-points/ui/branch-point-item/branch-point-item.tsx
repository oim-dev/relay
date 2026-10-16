import clsx from "clsx";
import { formatWorkTime } from "domains/work-history";
import type { BranchPointItemProps } from "./types/branch-point-item-props.type";
import styles from "./styles/branch-point-item.module.css";

/**
 * Представляет точку графа и открывает её полный материал в текущем окне.
 *
 * Используется для:
 *  - различения выбранной точки, checkpoints и событий жизненного цикла
 */
export const BranchPointItem = (props: BranchPointItemProps) => {
  const { point, isCurrent, onSelectPoint, className, ...rootAttrs } = props;
  const timeLabel = formatWorkTime(point.at);
  const current = isCurrent ? "true" : undefined;

  return (
    <button
      {...rootAttrs}
      type="button"
      className={clsx(styles.root, className)}
      aria-current={current}
      onClick={() => onSelectPoint(point.id)}
    >
      <span className={styles.meta}>
        <span>{point.label}</span>
        <time dateTime={point.at}>{timeLabel}</time>
      </span>
      <strong className={styles.title}>{point.title}</strong>
      {isCurrent && <span className={styles.current}>Открыт сейчас</span>}
    </button>
  );
};
