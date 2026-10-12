import { useId, useState } from "react";
import clsx from "clsx";
import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Collapse,
  Group,
  Menu,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { ChevronDown, ChevronRight, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useTaskCriterion } from "domains/board-tasks";
import { MarkdownView } from "ui/markdown-view";
import { isDefined } from "shared/value-predicates";
import type { CriterionRowProps } from "./types/criterion-row-props.type";
import styles from "./styles/criterion-row.module.css";

/**
 * Показывает условие приёмки и раскрывает его полное описание.
 *
 * Используется для:
 *  - независимого переключения выполнения и чтения описания
 *  - вызова редактирования и удаления выбранного критерия
 */
export const CriterionRow = (props: CriterionRowProps) => {
  const {
    projectId,
    taskId,
    criterion,
    isDisabled,
    onComplete,
    onEdit,
    onRemove,
    className,
    ...rootAttrs
  } = props;
  const [isExpanded, setExpanded] = useState(false);
  const bodyId = useId();
  const query = useTaskCriterion(projectId, taskId, isExpanded ? criterion.id : null);
  const detailData = query.data;
  const hasError = isDefined(query.error);
  const hasSummary = criterion.summary !== "";
  const checkboxLabel = `Выполнено: ${criterion.title}`;
  const menuLabel = `Действия критерия: ${criterion.title}`;
  const completionLabel = `Отметил: ${criterion.completedBy ?? ""} · ${criterion.completedAt ? new Date(criterion.completedAt).toLocaleString("ru-RU") : ""}`;
  const ChevronIcon = isExpanded ? ChevronDown : ChevronRight;
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <Checkbox
          mt="0.375rem"
          checked={criterion.completed}
          disabled={isDisabled}
          aria-label={checkboxLabel}
          onChange={(event) => onComplete(event.currentTarget.checked)}
        />
        <UnstyledButton
          className={styles.toggle}
          aria-expanded={isExpanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((previous) => !previous)}
        >
          <span className={styles.text}>
            <Text component="span" size="sm" fw={500}>
              {criterion.title}
            </Text>
            {hasSummary && (
              <Text component="span" size="xs" c="dimmed" className={styles.summary}>
                {criterion.summary}
              </Text>
            )}
          </span>
          <ChevronIcon size={16} className={styles.chevron} aria-hidden="true" />
        </UnstyledButton>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon aria-label={menuLabel} disabled={isDisabled}>
              <MoreHorizontal size={16} aria-hidden="true" />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<Pencil size={16} aria-hidden="true" />} onClick={onEdit}>
              Изменить критерий
            </Menu.Item>
            <Menu.Item
              color="danger"
              leftSection={<Trash2 size={16} aria-hidden="true" />}
              onClick={onRemove}
            >
              Удалить критерий
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
      <Collapse expanded={isExpanded} id={bodyId}>
        <div className={styles.description}>
          {query.isLoading && (
            <Text size="sm" c="dimmed" role="status">
              Загружаем описание…
            </Text>
          )}
          {hasError && (
            <Alert color="danger" title="Описание недоступно">
              <Button size="xs" variant="subtle" onClick={() => void query.mutate()}>
                Повторить загрузку описания
              </Button>
            </Alert>
          )}
          {isDefined(detailData) && (
            <MarkdownView
              text={detailData.criterion.description}
              emptyText="Полное описание не задано."
            />
          )}
          {criterion.completed && (
            <Text size="xs" c="dimmed" mt="sm">
              {completionLabel}
            </Text>
          )}
        </div>
      </Collapse>
    </div>
  );
};
