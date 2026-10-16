import clsx from "clsx";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useReducedMotion } from "@mantine/hooks";
import { ActionIcon, Progress, Tooltip, UnstyledButton } from "@mantine/core";
import {
  ArrowUpRight,
  CheckCheck,
  GitBranch,
  GripVertical,
  Layers,
  Link2,
  LockKeyhole,
  Puzzle,
  Route,
} from "lucide-react";
import { isDefined, isNonEmptyArray } from "shared/value-predicates";
import { StatusBadge } from "ui/status-badge";
import type { TaskCardProps, TaskCardPreviewProps } from "./types/task-card-props.type";
import styles from "./styles/task-card.module.css";

/**
 * Подключает перенос к единому представлению задачи без масштабирования содержимого.
 *
 * Используется для:
 *  - сортировки задач мышью, клавиатурой и сенсорной ручкой
 *  - сохранения точных размеров места вставки
 */
export const TaskCard = (props: TaskCardProps) => {
  const {
    task,
    target,
    targetState,
    version,
    isTarget,
    isAfterTarget,
    nextId,
    isDisabled,
    isPlaceholder,
    placeholderSize,
    onOpen,
    style,
    ...rootAttrs
  } = props;
  const drag = useSortable({
    id: task.id,
    data: { task, target, targetState, status: task.column, column: task.column, version, nextId },
    disabled: isDisabled,
  });
  const shouldReduceMotion = useReducedMotion();
  const isDragging = isPlaceholder || drag.isDragging;
  const transform = CSS.Translate.toString(drag.transform);
  const transition = shouldReduceMotion ? undefined : drag.transition;
  return (
    <TaskCardPreview
      {...rootAttrs}
      task={task}
      target={target}
      targetState={targetState}
      isOverlay={false}
      isPlaceholder={isDragging}
      isDisabled={isDisabled}
      nodeRef={drag.setNodeRef}
      handleRef={drag.setActivatorNodeRef}
      handleProps={{ ...drag.attributes, ...drag.listeners }}
      onMouseDown={(event) => drag.listeners?.onMouseDown?.(event)}
      onOpen={onOpen}
      style={{ ...style, ...placeholderSize, transform, transition }}
      data-target={isTarget}
      data-after={isAfterTarget}
    />
  );
};

/**
 * Показывает цель работы, приёмку и зависимости с одинаковой геометрией во время drag.
 *
 * Используется для:
 *  - интерактивной карточки в колонке
 *  - замороженного превью без второго sortable и доступных для фокуса элементов
 */
export const TaskCardPreview = (props: TaskCardPreviewProps) => {
  const {
    task,
    target,
    targetState,
    isOverlay = true,
    isPlaceholder = false,
    isDisabled = false,
    nodeRef,
    handleRef,
    handleProps,
    onMouseDown,
    onOpen,
    className,
    ...rootAttrs
  } = props;
  const title = task.title || "Без названия";
  const isUntitled = task.title === "";
  const hasTarget = isNonEmptyArray(task.productLinks);
  const moreTargets = task.productLinks.length - 1;
  const hasMoreTargets = moreTargets > 0;
  const targetKind = target?.requirementKind;
  const TargetIcon = targetKind === "scenario" ? Route : targetKind === "feature" ? Puzzle : Layers;
  const targetLabel =
    targetKind === "scenario" ? "Сценарий" : targetKind === "feature" ? "Фича" : "Реализует";
  const targetTitle =
    target?.title || (targetState === "loading" ? "Загружаем цель…" : "Цель недоступна");
  const targetHint = `${target?.label ?? targetLabel}: ${targetTitle}${target?.isActive === false ? " · Участие снято" : ""}`;
  const cardHint = hasTarget ? `${title}\n${targetHint}` : title;
  const hasCriteria = task.acceptance.total > 0;
  const isAccepted = hasCriteria && task.acceptance.completed === task.acceptance.total;
  const criteriaValue = hasCriteria ? (task.acceptance.completed / task.acceptance.total) * 100 : 0;
  const criteriaLabel = `Критерии приёмки: ${task.acceptance.completed} из ${task.acceptance.total}`;
  const hasDependencies = isNonEmptyArray(task.dependencies);
  const hasRelated = isNonEmptyArray(task.related);
  const hasParent = isDefined(task.parentId);
  const hasRelations = hasDependencies || hasRelated || hasParent;
  const hasFooter = task.blocked || hasRelations;
  const blockersCount = task.blockers.length;
  const taskWord =
    blockersCount % 10 === 1 && blockersCount % 100 !== 11
      ? "задачу"
      : blockersCount % 10 >= 2 &&
          blockersCount % 10 <= 4 &&
          (blockersCount % 100 < 12 || blockersCount % 100 > 14)
        ? "задачи"
        : "задач";
  const blockerLabel = `Ожидает ${blockersCount} ${taskWord}`;
  const hasHiddenContent = isOverlay || isPlaceholder;
  const isTooltipDisabled = hasHiddenContent;
  // Место вставки остаётся доступной карточкой: в нём сохраняется фокус ручки переноса.
  const isAriaHidden = isOverlay || undefined;
  const rootClassName = clsx(
    styles.root,
    className,
    isOverlay && styles._overlay,
    isPlaceholder && styles._placeholder,
  );
  const titleClassName = clsx(styles.title, isUntitled && styles._untitled);
  const acceptanceClassName = clsx(styles.acceptance, isAccepted && styles._accepted);
  return (
    <article
      {...rootAttrs}
      ref={nodeRef}
      className={rootClassName}
      data-task-id={task.id}
      data-overlay={isOverlay || undefined}
      data-dragging={isPlaceholder}
      aria-hidden={isAriaHidden}
      inert={isOverlay || undefined}
    >
      <div className={styles.header}>
        <span className={styles.key} title={task.key}>
          {task.key}
        </span>
        <ActionIcon
          ref={handleRef}
          {...handleProps}
          variant="subtle"
          color="gray"
          size={24}
          aria-label={`Перенести ${task.key}`}
          className={styles.handle}
          data-drag-handle
          // Во время сохранения перенос недоступен (aria-disabled от dnd-kit), но ручка
          // остаётся фокусируемой: на ней после переноса находится фокус клавиатуры.
          data-disabled={isDisabled || undefined}
          onMouseDown={(event) => {
            event.stopPropagation();
            handleProps?.onMouseDown?.(event);
          }}
        >
          <GripVertical size={15} aria-hidden="true" />
        </ActionIcon>
      </div>
      <Tooltip
        label={cardHint}
        multiline
        maw={360}
        openDelay={650}
        disabled={isTooltipDisabled}
        events={{ hover: true, focus: true, touch: false }}
      >
        <UnstyledButton
          className={titleClassName}
          aria-label={`Открыть ${task.key}: ${title}`}
          data-open-task
          onClick={() => onOpen?.(task.id)}
          onMouseDown={onMouseDown}
        >
          {title}
        </UnstyledButton>
      </Tooltip>
      {hasTarget && (
        <div className={styles.context}>
          <span className={styles.target} title={targetHint}>
            <TargetIcon size={14} aria-hidden="true" />
            <span className={styles.targetText}>
              <span className={styles.targetKind}>{targetLabel} · </span>
              {targetTitle}
            </span>
          </span>
          {hasMoreTargets && (
            <span className={styles.more} title={`Ещё целей реализации: ${moreTargets}`}>
              +{moreTargets}
            </span>
          )}
        </div>
      )}
      {hasCriteria && (
        <div className={acceptanceClassName}>
          <div className={styles.criteriaHeader}>
            <span className={styles.criteriaLabel}>
              <CheckCheck size={14} aria-hidden="true" />
              Критерии приёмки
            </span>
            <span className={styles.count}>
              {task.acceptance.completed}
              <span className={styles.total}> / {task.acceptance.total}</span>
            </span>
          </div>
          <Progress variant="accent" value={criteriaValue} aria-label={criteriaLabel} />
        </div>
      )}
      {hasFooter && (
        <div className={styles.footer}>
          {task.blocked && (
            <StatusBadge
              tone="danger"
              icon={<LockKeyhole size={12} aria-hidden="true" />}
              className={styles.blocker}
            >
              {blockerLabel}
            </StatusBadge>
          )}
          {hasRelations && (
            <div className={styles.relations}>
              {hasDependencies && (
                <span className={styles.relation} title="Прямые зависимости">
                  <GitBranch size={12} aria-hidden="true" />
                  Зависимости · {task.dependencies.length}
                </span>
              )}
              {hasRelated && (
                <span className={styles.relation}>
                  <Link2 size={12} aria-hidden="true" />
                  Связанные · {task.related.length}
                </span>
              )}
              {hasParent && (
                <span className={styles.relation} title="У задачи есть родитель">
                  <ArrowUpRight size={12} aria-hidden="true" />
                  Подзадача
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
};
