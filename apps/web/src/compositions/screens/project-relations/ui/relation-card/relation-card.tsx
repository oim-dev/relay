import { useState } from "react";
import {
  ActionIcon,
  Anchor,
  Button,
  Collapse,
  Group,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { ArrowRight, ChevronDown, ChevronUp } from "lucide-react";
import { relationAddress } from "domains/relations";
import { MarkdownView } from "ui/markdown-view";
import { getEntityPresentation, getRelationLabel } from "../../config/relation-presentation";
import type { RelationCardProps } from "./types/relation-card-props.type";
import styles from "./styles/relation-card.module.css";

/**
 * Показывает связанную сущность и раскрывает основания отношения по запросу.
 *
 * Используется для:
 *  - чтения окружения без повторения корневой сущности в каждой строке
 *  - просмотра полного направления, пояснения и отзыва явной связи
 */
export const RelationCard = ({
  edge,
  fromLabel,
  toLabel,
  neighbor,
  onSelect,
  onRemove,
}: RelationCardProps) => {
  const [isExpanded, setExpanded] = useState(false);
  const [isConfirming, setConfirming] = useState(false);
  const [isRemoving, setRemoving] = useState(false);
  const sourceLabel = "Сохранена в Core";
  const hasDescription = edge.description !== "";
  const hasNeighbor = neighbor !== undefined;
  const isIndirect = !hasNeighbor;
  const presentation = getEntityPresentation(neighbor?.ref.kind ?? edge.to.kind);
  const label = neighbor?.title ?? `${fromLabel} → ${toLabel}`;
  const keyLabel = neighbor?.key ?? getRelationLabel(edge.type);
  const address = relationAddress(neighbor?.ref ?? edge.to);
  const DetailsIcon = isExpanded ? ChevronUp : ChevronDown;
  const detailsLabel = `Подробности связи: ${keyLabel}`;
  const shouldShowRemove = !isConfirming;
  /**
   * Блокирует повтор и сохраняет подтверждение при ошибке записи.
   */
  const handleRemove = async (): Promise<void> => {
    setRemoving(true);
    try {
      await onRemove(edge.id);
      setConfirming(false);
    } finally {
      setRemoving(false);
    }
  };
  return (
    <article className={styles.root}>
      <div className={styles.row}>
        <UnstyledButton
          className={styles.entity}
          onClick={() => onSelect(address)}
          aria-label={`Связи: ${label}`}
        >
          <ThemeIcon variant="light" color="accent" size={32}>
            <presentation.icon size={17} aria-hidden="true" />
          </ThemeIcon>
          <span className={styles.label}>
            <Text component="span" size="xs" c="dimmed">
              {keyLabel} · {presentation.label}
            </Text>
            <Text component="span" size="sm" fw={500}>
              {label}
            </Text>
          </span>
          <ArrowRight size={15} aria-hidden="true" className={styles.arrow} />
        </UnstyledButton>
        <Tooltip label="Пояснение и действия" events={{ hover: true, focus: true, touch: false }}>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={detailsLabel}
            aria-expanded={isExpanded}
            onClick={() => setExpanded(!isExpanded)}
          >
            <DetailsIcon size={17} aria-hidden="true" />
          </ActionIcon>
        </Tooltip>
      </div>
      <Collapse expanded={isExpanded}>
        <Stack className={styles.details} gap="sm">
          <Group gap={6}>
            <Anchor
              component="button"
              size="sm"
              ta="left"
              onClick={() => onSelect(relationAddress(edge.from))}
            >
              {fromLabel}
            </Anchor>
            <span className={styles.type}>{getRelationLabel(edge.type)} →</span>
            <Anchor
              component="button"
              size="sm"
              ta="left"
              onClick={() => onSelect(relationAddress(edge.to))}
            >
              {toLabel}
            </Anchor>
          </Group>
          {hasDescription && <MarkdownView text={edge.description} />}
          <Text size="xs" c="dimmed">
            {sourceLabel} · {edge.type} · {edge.createdBy} · ревизия {edge.revision}
          </Text>
          <Text size="xs" c="dimmed">
            Предметные связи изменяются в редакторе их владельца. Здесь можно отозвать отдельное
            диагностическое ребро.
          </Text>
          {isIndirect && (
            <Text size="xs" c="dimmed">
              Связь между другими сущностями окружения; не прямая связь выбранной записи.
            </Text>
          )}
          {shouldShowRemove && (
            <Button
              variant="subtle"
              color="danger"
              size="compact-xs"
              onClick={() => setConfirming(true)}
              className={styles.remove}
            >
              Отозвать диагностическое ребро…
            </Button>
          )}
          {isConfirming && (
            <Stack gap="xs">
              <Text size="sm">
                Отозвать диагностическое ребро? Сущности сохранятся; предметный линк меняется в
                своём редакторе.
              </Text>
              <Group gap="xs">
                <Button
                  size="xs"
                  color="danger"
                  loading={isRemoving}
                  onClick={() => void handleRemove()}
                >
                  Отозвать ребро
                </Button>
                <Button
                  size="xs"
                  variant="default"
                  disabled={isRemoving}
                  onClick={() => setConfirming(false)}
                >
                  Оставить
                </Button>
              </Group>
            </Stack>
          )}
        </Stack>
      </Collapse>
    </article>
  );
};
