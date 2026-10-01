import clsx from "clsx";
import { Progress } from "@mantine/core";
import { Link } from "react-router-dom";
import type { MetricBoardProps } from "./types/metric-board-props.type";
import styles from "./styles/metric-board.module.css";

/**
 * Показывает, сколько незавершённых задач на доске, полосой относительно самой
 * нагруженной доски и точными числами исполняемой работы. Задачи с блокерами —
 * пересекающийся показатель тех же незавершённых задач, а не отдельная часть суммы.
 *
 * Используется для:
 *  - распределения незавершённой работы по доскам в блоке «Доски»
 *  - перехода к канбану доски
 */
export const MetricBoard = (props: MetricBoardProps) => {
  const { entry, scale, basePath, className, ...rootAttrs } = props;
  const { board } = entry;
  const { tasks } = board;
  const share = scale === 0 ? 0 : (tasks.remaining / scale) * 100;
  const detailItems = [
    `в работе ${tasks.byColumn["in-progress"]}`,
    `на проверке ${tasks.byColumn.review}`,
    `с блокерами ${tasks.blockedRemaining} из ${tasks.remaining} незавершённых`,
    `всего задач ${tasks.total}`,
  ];
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <Link to={`${basePath}/boards/${encodeURIComponent(board.slug)}`} className={styles.link}>
        <span className={styles.prefix}>{board.prefix}</span>
        <span className={styles.name}>{board.name}</span>
        <span className={styles.remaining}>
          {tasks.remaining}
          <span className={styles.unit}> незавершённых</span>
        </span>
      </Link>
      {/* Полоса повторяет подписанное число и скрыта от скринридера. */}
      <Progress variant="accent" value={share} aria-hidden="true" />
      <p className={styles.meta}>
        {detailItems.map((item) => (
          <span key={item}>{item}</span>
        ))}
      </p>
    </div>
  );
};
