import clsx from "clsx";
import { TASK_COLUMNS } from "domains/board-tasks";
import type { TaskStagesProps } from "./types/task-stages-props.type";
import styles from "./styles/task-stages.module.css";

/**
 * Показывает задачи по всем шести колонкам и пересекающиеся показатели выполнения.
 *
 * Используется для:
 *  - оценки текущей стадии работы без интерпретации цвета
 *  - отличия фактического выполнения от колонки done
 */
export const TaskStages = (props: TaskStagesProps) => {
  const { tasks, className, ...rootAttrs } = props;
  const stageItems = TASK_COLUMNS.map((column) => {
    const count = tasks.byColumn[column.value];
    const share = tasks.total === 0 ? 0 : Math.round((count / tasks.total) * 100);
    return { value: column.value, label: column.label, count, width: `${share}%` };
  });
  const criteriaLabel = `${tasks.criteria.completed} из ${tasks.criteria.total}`;
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <ul className={styles.stages} aria-label="Задачи по колонкам">
        {stageItems.map((stage) => (
          <li key={stage.value} className={styles.stage} data-column={stage.value}>
            <span className={styles.stageLabel}>{stage.label}</span>
            <span className={styles.track} aria-hidden="true">
              <span className={styles.bar} style={{ width: stage.width }} />
            </span>
            <span className={styles.stageCount}>{stage.count}</span>
          </li>
        ))}
      </ul>
      <div className={styles.facts}>
        <p className={styles.factsNote}>
          Показатели ниже пересекаются между собой и не складываются в общее число.
        </p>
        <dl className={styles.factList}>
          <div className={styles.fact}>
            <dt>Фактически выполнено</dt>
            <dd>{tasks.completed}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Готовы к началу</dt>
            <dd>{tasks.readyToStart}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Заблокированы</dt>
            <dd>{tasks.blocked}</dd>
          </div>
          <div className={styles.fact}>
            <dt>В «Готово», но обязательства не выполнены</dt>
            <dd>{tasks.doneWithOpenObligations}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Критерии приёмки выполнены</dt>
            <dd>{criteriaLabel}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Невыполненные критерии</dt>
            <dd>{tasks.criteria.pending}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Задачи с невыполненными критериями</dt>
            <dd>{tasks.criteria.tasksWithPending}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
};
