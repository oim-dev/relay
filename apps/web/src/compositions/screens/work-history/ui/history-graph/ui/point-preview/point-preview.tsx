import clsx from "clsx";
import { Bot } from "lucide-react";
import { WorkAuthorAvatar, formatWorkTime } from "domains/work-history";
import type { PointPreviewProps } from "./types/point-preview-props.type";
import styles from "./styles/point-preview.module.css";

/**
 * Показывает исполнителя, смысл события и контекст работы в компактной подсказке.
 *
 * Используется для:
 *  - быстрого чтения графа без запроса полных материалов
 *  - раздельного представления агента и человека-оператора
 */
export const PointPreview = (props: PointPreviewProps) => {
  const {
    point,
    run,
    workTitle,
    eventLabel,
    continuationLabel,
    isOutsidePage,
    className,
    ...rootAttrs
  } = props;
  const agentName = run?.actor ?? "Агент не указан";
  const clientName = run?.client?.trim() ?? "";
  const hasClient = clientName !== "";
  const operator = run?.operator ?? null;
  const operatorName = operator?.name?.trim() ?? "";
  const hasOperator = operatorName !== "";
  const hasSummary = point.summary.trim() !== "";
  const hasContinuation = continuationLabel !== null;
  const isOpenIntent = point.kind === "checkpoint" && point.intentState === "open";
  const savedAt = new Date(point.at);
  const timeLabel = savedAt.toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    year: savedAt.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const fullTimeLabel = formatWorkTime(point.at);
  const timeDescription = `${hasContinuation ? "Последняя сохранённая точка" : "Сохранено"}: ${fullTimeLabel}`;

  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <div className={styles.agent}>
        <span className={styles.agentIcon}>
          <Bot size={20} aria-hidden="true" />
        </span>
        <div className={styles.identity}>
          <strong className={styles.agentName}>{agentName}</strong>
          {hasClient && <span className={styles.client}>{clientName}</span>}
        </div>
      </div>
      <div className={styles.event}>
        <span className={styles.eventKind}>{eventLabel}</span>
        <time className={styles.time} dateTime={point.at} title={timeDescription}>
          {timeLabel}
        </time>
      </div>
      <div className={styles.material}>
        <strong className={styles.title}>{point.title}</strong>
        {hasSummary && <p className={styles.summary}>{point.summary}</p>}
        {isOpenIntent && <span className={styles.intent}>Намерение открыто</span>}
      </div>
      {hasContinuation && (
        <div className={styles.continuation}>
          <strong>{continuationLabel}</strong>
          <span>Последняя сохранённая точка, не текущая активность агента.</span>
        </div>
      )}
      <div className={styles.context}>
        <dl className={styles.work}>
          <dt className={styles.caption}>Работа</dt>
          <dd className={styles.workTitle}>{workTitle}</dd>
        </dl>
        {hasOperator && (
          <div className={styles.operator}>
            <WorkAuthorAvatar operator={operator} size={28} />
            <div className={styles.identity}>
              <span className={styles.caption}>Оператор</span>
              <span>{operatorName}</span>
            </div>
          </div>
        )}
        {isOutsidePage && (
          <p className={styles.caption}>Последняя точка ветки вне загруженной страницы</p>
        )}
      </div>
      <span className={styles.hint}>Нажмите на точку, чтобы открыть полный материал</span>
    </div>
  );
};
