import clsx from "clsx";
import type { CSSProperties } from "react";
import { Tooltip } from "@mantine/core";
import {
  ArrowRightLeft,
  Check,
  CircleDot,
  GitBranch,
  Hourglass,
  Pause,
  Play,
  X,
} from "lucide-react";
import { getWorkPointPresentation, formatWorkTime } from "domains/work-history";
import { PointPreview } from "compositions/screens/work-history/ui/history-graph/ui/point-preview";
import type { GraphPointProps } from "./types/graph-point-props.type";
import styles from "./styles/graph-point.module.css";

/**
 * Представляет реальную точку и место продолжения незавершённой ветки.
 *
 * Используется для:
 *  - локальной hover/focus-карточки без полнотекстового GET
 *  - адресного открытия материала по клавиатуре или нажатию
 */
export const GraphPoint = (props: GraphPointProps) => {
  const {
    row,
    isOpenEnd,
    isOutsidePage,
    isSelected,
    isHighlighted,
    onSelectPoint,
    className,
    ...rootAttrs
  } = props;
  const { point, run, branch } = row;
  const isPrimary = branch.parentSessionId === null;
  const roleLabel = isPrimary ? "Основной агент" : "Субагент";
  const roleKey = isPrimary ? "primary" : "worker";
  const presentation = getWorkPointPresentation(point, run, branch);
  const icons = {
    checkpoint: CircleDot,
    start: GitBranch,
    finish: Check,
    pause: Pause,
    handoff: ArrowRightLeft,
    cancel: X,
    run: Play,
  };
  const Icon = icons[presentation.marker];
  const OpenEndIcon = branch.status === "paused" ? Pause : Hourglass;
  const operatorName = run?.operator?.name ?? "Пользователь не указан";
  const timeLabel = formatWorkTime(point.at);
  const title = point.title;
  const label = presentation.label;
  const isCheckpoint = point.kind === "checkpoint";
  const openEndId = isOpenEnd ? point.id : undefined;
  const continuationLabel =
    branch.status === "pending"
      ? "Ожидает подключения агента"
      : branch.status === "paused"
        ? "Приостановлено · точка продолжения"
        : "Не завершено · точка продолжения";
  const tooltipDateLabel = isOpenEnd ? "Последняя сохранённая точка" : "Сохранено";
  const endLabel = isOpenEnd ? ` ${continuationLabel}.` : "";
  const agentName = run?.actor ?? "Агент не указан";
  const ariaLabel = `${agentName}. ${roleLabel}. ${label}: ${title}. Работа: ${branch.title}.${endLabel} Оператор: ${operatorName}. ${tooltipDateLabel}: ${timeLabel}`;
  const previewContinuation = isOpenEnd ? continuationLabel : null;
  const pointStyle: CSSProperties & { "--graph-color": string } = {
    left: row.x - 22,
    top: row.y - 22,
    "--graph-color": row.color,
  };
  return (
    <Tooltip
      withinPortal
      withArrow
      multiline
      interactive
      position="right-start"
      radius="md"
      offset={12}
      middlewares={{
        flip: { fallbackAxisSideDirection: "end", padding: 12 },
        shift: { crossAxis: true, padding: 12 },
      }}
      openDelay={160}
      events={{ hover: true, focus: true, touch: false }}
      classNames={{ tooltip: styles.tooltip }}
      label={
        <PointPreview
          point={point}
          run={run}
          workTitle={branch.title}
          eventLabel={label}
          continuationLabel={previewContinuation}
          isOutsidePage={isOutsidePage}
        />
      }
    >
      <button
        {...rootAttrs}
        type="button"
        className={clsx(styles.root, className)}
        style={pointStyle}
        data-graph-point={point.id}
        data-open-end={openEndId}
        data-session-id={point.sessionId}
        data-agent-role={roleKey}
        data-selected={isSelected}
        data-highlighted={isHighlighted}
        data-checkpoint={isCheckpoint}
        aria-label={ariaLabel}
        aria-pressed={isSelected}
        onClick={(event) => onSelectPoint(point.id, event.currentTarget)}
      >
        <span className={styles.anchor}>
          <span className={styles.marker}>
            <Icon size={16} aria-hidden="true" />
          </span>
          {isOpenEnd && (
            <span className={styles.endMarker}>
              <OpenEndIcon size={12} aria-hidden="true" />
            </span>
          )}
        </span>
      </button>
    </Tooltip>
  );
};
