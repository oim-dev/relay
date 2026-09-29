import clsx from "clsx";
import { Link } from "react-router-dom";
import type { BoardListProps } from "./types/board-list-props.type";
import styles from "./styles/board-list.module.css";

/**
 * Показывает доски проекта с числом открытых и всех задач, включая пустые доски.
 *
 * Используется для:
 *  - перехода из обзора к канбану нужной доски
 */
export const BoardList = (props: BoardListProps) => {
  const { boards, basePath, className, ...rootAttrs } = props;
  const boardItems = boards.map((board) => ({
    ...board,
    path: `${basePath}/boards/${encodeURIComponent(board.slug)}`,
    countLabel: `открыто ${board.openTaskCount} из ${board.taskCount}`,
  }));
  return (
    <ul {...rootAttrs} className={clsx(styles.root, className)}>
      {boardItems.map((board) => (
        <li key={board.id}>
          <Link to={board.path} className={styles.link}>
            <span className={styles.prefix}>{board.prefix}</span>
            <span className={styles.name}>{board.name}</span>
            <span className={styles.count}>{board.countLabel}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
};
