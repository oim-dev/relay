import clsx from "clsx";
import { Button, Progress, Skeleton, Stack, Text } from "@mantine/core";
import { useApplicationTaskProgress } from "domains/board-tasks";
import { useProjectId } from "domains/project";
import { isDefined } from "shared/value-predicates";
import type { ApplicationProgressProps } from "./types/application-progress-props.type";
import styles from "./styles/application-progress.module.css";

/**
 * Показывает выполнение бизнес-задач и всей доски приложения.
 *
 * Используется для:
 *  - сравнения прогресса приложений без открытия досок
 *  - различения пустой доски, загрузки и недоступных данных
 */
export const ApplicationProgress = (props: ApplicationProgressProps) => {
  const { board, className, ...rootAttrs } = props;
  const project = useProjectId();
  const query = useApplicationTaskProgress(project, board);
  const progressData = query.data;

  if (isDefined(query.error)) {
    return (
      <div {...rootAttrs} className={clsx(styles.root, className)}>
        <Text size="sm" c="dimmed" role="status">
          Не удалось загрузить прогресс
        </Text>
        <Button
          className={styles.retry}
          variant="default"
          size="compact-sm"
          loading={query.isValidating}
          onClick={() => void query.mutate().catch(() => undefined)}
        >
          Повторить
        </Button>
      </div>
    );
  }

  if (!isDefined(progressData)) {
    return (
      <div
        {...rootAttrs}
        className={clsx(styles.root, className)}
        aria-busy="true"
        aria-label="Загрузка прогресса"
      >
        <Stack gap="sm">
          <Skeleton height={15} width="65%" />
          <Skeleton height={8} />
          <Skeleton height={12} width="45%" />
        </Stack>
        <Stack gap="sm">
          <Skeleton height={15} width="65%" />
          <Skeleton height={6} />
          <Skeleton height={12} width="45%" />
        </Stack>
      </div>
    );
  }

  const progressItems = [
    {
      id: "business",
      label: "Бизнес-прогресс",
      description: "Задачи фич и сценариев",
      empty: "Нет связанных задач",
      ...progressData.business,
    },
    {
      id: "overall",
      label: "Общий прогресс",
      description: "Все задачи доски",
      empty: "На доске пока нет задач",
      ...progressData.overall,
    },
  ].map((entry) => {
    const hasTasks = entry.total > 0;
    const isBusiness = entry.id === "business";
    const percent = hasTasks ? Math.floor((entry.completed / entry.total) * 100) : 0;
    return {
      ...entry,
      percent,
      percentLabel: hasTasks ? `${percent}%` : "—",
      countLabel: hasTasks ? `${entry.completed} / ${entry.total} выполнено` : entry.empty,
      accessibleLabel: `${entry.label}: ${entry.completed} из ${entry.total} задач выполнено`,
      variant: isBusiness ? "accent" : undefined,
      barClassName: isBusiness ? undefined : styles.neutralBar,
      className: clsx(styles.metric, isBusiness && styles._business),
    };
  });

  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      {progressItems.map((entry) => (
        <div key={entry.id} className={entry.className}>
          <div className={styles.heading}>
            <span className={styles.label}>{entry.label}</span>
            <strong className={styles.percent}>{entry.percentLabel}</strong>
          </div>
          <Progress
            value={entry.percent}
            variant={entry.variant}
            className={entry.barClassName}
            aria-label={entry.accessibleLabel}
          />
          <div className={styles.caption}>
            <span>{entry.description}</span>
            <span className={styles.count}>{entry.countLabel}</span>
          </div>
        </div>
      ))}
    </div>
  );
};
