import type { CSSProperties } from "react";
import clsx from "clsx";
import { TASK_COLUMNS } from "domains/board-tasks";
import { OVERVIEW_SECTION_IDS } from "../../config/overview.config";
import type { TaskStagesProps } from "./types/task-stages-props.type";
import styles from "./styles/task-stages.module.css";

/**
 * Показывает задачи по всем шести колонкам и пересекающиеся показатели выполнения.
 * Полоса повторяет легенду и скрыта от вспомогательных технологий: каждое число подписано.
 *
 * Используется для:
 *  - оценки текущей стадии работы без интерпретации цвета
 *  - отличия фактического выполнения от колонки «Готово»
 */
export const TaskStages = (props: TaskStagesProps) => {
  const { tasks, className, ...rootAttrs } = props;
  const stageItems = TASK_COLUMNS.map((column) => ({
    value: column.value,
    label: column.label,
    count: tasks.byColumn[column.value],
    emptyMark: tasks.byColumn[column.value] === 0 ? "" : undefined,
  }));
  const segmentItems = stageItems.filter((stage) => stage.count > 0);
  const { criteria } = tasks;
  const criteriaLabel = `${criteria.completed} из ${criteria.total}`;
  const criteriaShare = criteria.total === 0 ? 0 : (criteria.completed / criteria.total) * 100;
  // Геометрия полосы критериев; сами числа подписаны текстом рядом.
  const meterStyle: CSSProperties & Record<"--criteria-share", string> = {
    "--criteria-share": `${criteriaShare}%`,
  };
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <div className={styles.bar} aria-hidden="true">
        {segmentItems.map((stage) => (
          <span
            key={stage.value}
            className={styles.segment}
            data-column={stage.value}
            style={{ flexGrow: stage.count }}
          />
        ))}
      </div>
      <ul className={styles.stages} aria-label="Задачи по колонкам">
        {stageItems.map((stage) => (
          <li
            key={stage.value}
            className={styles.stage}
            data-column={stage.value}
            data-empty={stage.emptyMark}
          >
            <span className={styles.stageLabel}>{stage.label}</span>
            <span className={styles.marker} aria-hidden="true" />
            <span className={styles.stageCount}>{stage.count}</span>
          </li>
        ))}
      </ul>
      <section
        id={OVERVIEW_SECTION_IDS.taskFacts}
        className={styles.facts}
        aria-labelledby={`${OVERVIEW_SECTION_IDS.taskFacts}-title`}
      >
        <div className={styles.factsHeader}>
          <h3 id={`${OVERVIEW_SECTION_IDS.taskFacts}-title`} className={styles.factsTitle}>
            Выполнение и готовность
          </h3>
          <p className={styles.factsNote}>
            Показатели пересекаются между собой и не складываются в общее число.
          </p>
        </div>
        <dl className={styles.factList}>
          <div className={styles.lead} data-fact="completed">
            <dt>Фактически выполнено</dt>
            <dd>{tasks.completed}</dd>
          </div>
          <div className={styles.lead} data-fact="criteria" style={meterStyle}>
            <dt>Критерии приёмки выполнены</dt>
            <dd>{criteriaLabel}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Готовы к началу</dt>
            <dd>{tasks.readyToStart}</dd>
          </div>
          <div className={styles.fact} data-fact="blocked">
            <dt>Заблокированы</dt>
            <dd>{tasks.blocked}</dd>
          </div>
          <div className={styles.fact}>
            <dt>В «Готово», но обязательства не выполнены</dt>
            <dd>{tasks.doneWithOpenObligations}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Невыполненные критерии</dt>
            <dd>{criteria.pending}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Задачи с невыполненными критериями</dt>
            <dd>{criteria.tasksWithPending}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
};
