import clsx from "clsx";
import { OVERVIEW_SECTION_IDS, TASK_STATE_ICONS } from "../../config/overview.config";
import type { OverviewMetricsProps } from "./types/overview-metrics-props.type";
import styles from "./styles/overview-metrics.module.css";

/**
 * Показывает четыре операционных числа задач проекта с переходом к их группам на экране.
 * Числа берутся из среза обзора без пересчёта. «В работе» — выделенная карточка экрана,
 * блокировка становится громким сигналом только при наличии. У каждого показателя своя
 * иконка из общей системы состояний задач.
 *
 * Используется для:
 *  - первого ответа на вопрос «что сейчас в работе и что мешает»
 *  - перехода к группам «Требует внимания» и показателям выполнения
 */
export const OverviewMetrics = (props: OverviewMetricsProps) => {
  const { tasks, className, ...rootAttrs } = props;
  const hasBlocked = tasks.blocked > 0;
  const metricItems = [
    {
      key: "in-progress",
      Icon: TASK_STATE_ICONS["in-progress"],
      label: "В работе",
      value: tasks.byColumn["in-progress"],
      hint: "задачи в колонке «В\u00A0работе»",
      target: OVERVIEW_SECTION_IDS.attentionInProgress,
      isAlert: false,
    },
    {
      key: "review",
      Icon: TASK_STATE_ICONS.review,
      label: "На проверке",
      value: tasks.byColumn.review,
      hint: "ждут решения проверяющего",
      target: OVERVIEW_SECTION_IDS.attentionReview,
      isAlert: false,
    },
    {
      key: "ready",
      Icon: TASK_STATE_ICONS.ready,
      label: "Готовы к началу",
      value: tasks.readyToStart,
      hint: "можно брать в работу",
      target: OVERVIEW_SECTION_IDS.taskFacts,
      isAlert: false,
    },
    {
      key: "blocked",
      Icon: TASK_STATE_ICONS.blocked,
      label: "Заблокированы",
      value: tasks.blocked,
      hint: hasBlocked ? "ждут зависимостей или подзадач" : "блокировок нет",
      target: OVERVIEW_SECTION_IDS.attentionBlocked,
      isAlert: hasBlocked,
    },
  ].map((item) => ({
    ...item,
    href: `#${item.target}`,
    alertMark: item.isAlert ? "" : undefined,
  }));
  return (
    <ul
      {...rootAttrs}
      className={clsx(styles.root, className)}
      aria-label="Операционные показатели"
    >
      {metricItems.map((item) => (
        <li key={item.key} className={styles.item}>
          <a
            href={item.href}
            className={styles.tile}
            data-metric={item.key}
            data-alert={item.alertMark}
          >
            <span className={styles.label}>
              <item.Icon size={16} className={styles.icon} aria-hidden="true" />
              {item.label}
            </span>
            <span className={styles.value}>{item.value}</span>
            <span className={styles.hint}>{item.hint}</span>
          </a>
        </li>
      ))}
    </ul>
  );
};
