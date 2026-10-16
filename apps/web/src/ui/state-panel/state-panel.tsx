import clsx from "clsx";
import { Loader } from "@mantine/core";
import { CircleAlert, Layers3 } from "lucide-react";
import type { StatePanelProps } from "./types/state-panel-props.type";
import styles from "./styles/state-panel.module.css";

/**
 * Объясняет пустое состояние, ожидание или отказ и предлагает следующий шаг.
 * Не заменяет уже показанные данные: обновление и устаревание сообщает Alert рядом с ними.
 *
 * Используется для:
 *  - первичной загрузки раздела, пустого каталога и отсутствия совпадений
 *  - ошибки чтения или отсутствующей записи с действием восстановления
 */
export const StatePanel = (props: StatePanelProps) => {
  const {
    title,
    titleAs: Heading = "h2",
    description,
    action,
    state = "empty",
    className,
    ...rootAttrs
  } = props;
  const isError = state === "error";
  const isLoading = state === "loading";
  const role = isError ? "alert" : "status";
  return (
    <div
      {...rootAttrs}
      className={clsx(styles.root, className)}
      data-state={state}
      role={role}
      aria-busy={isLoading || undefined}
    >
      <div className={styles.icon} aria-hidden="true">
        {isLoading && <Loader size={22} color="var(--tasks-muted)" />}
        {isError && <CircleAlert size={24} />}
        {!isLoading && !isError && <Layers3 size={24} />}
      </div>
      <Heading className={styles.title}>{title}</Heading>
      <p className={styles.description}>{description}</p>
      {action}
    </div>
  );
};
