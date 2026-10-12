import clsx from "clsx";
import { ActionIcon, Checkbox, UnstyledButton, VisuallyHidden } from "@mantine/core";
import { ChevronRight, ListChecks } from "lucide-react";
import { ProductReadiness } from "domains/product-demo";
import { ProductKey } from "domains/product";
import type { ScopeNodeProps } from "./types/scope-node-props.type";
import styles from "./styles/scope-node.module.css";

/**
 * Разделяет включение в состав, раскрытие и выбор редактируемого описания.
 *
 * Используется для:
 *  - работы с независимым выбором фич и сценариев
 */
export const ScopeNode = (props: ScopeNodeProps) => {
  const { entry, payload, isCurrent, onInspect, onToggle, onSelectAll, className, ...rootAttrs } =
    props;
  const { feature, scenario } = entry;
  const { elementProps, tree, node, hasChildren, expanded } = payload;
  const item = scenario ?? feature;
  const isFeature = scenario === undefined;
  const isEnabled = feature.isEnabled && item.isEnabled;
  const needsDescription = isEnabled && !item.hasDescription;
  const selectedCount = feature.scenarios.filter((child) => child.isEnabled).length;
  const hasScenarioSelection = isFeature && hasChildren;
  const toggleLabel = `${expanded ? "Свернуть" : "Раскрыть"} сценарии: ${feature.name}`;
  return (
    <div
      {...rootAttrs}
      {...elementProps}
      className={clsx(elementProps.className, styles.root, isCurrent && styles._current, className)}
    >
      <span className={styles.arrowSlot}>
        {hasChildren && (
          <ActionIcon
            variant="subtle"
            size="xs"
            className={styles.touchControl}
            aria-label={toggleLabel}
            aria-expanded={expanded}
            onClick={(event) => {
              event.stopPropagation();
              tree.toggleExpanded(node.value);
            }}
            onKeyDown={(event) => {
              if (event.key === " " || event.key === "Enter") event.stopPropagation();
            }}
          >
            <ChevronRight
              size={14}
              aria-hidden="true"
              className={clsx(styles.chevron, expanded && styles._expanded)}
            />
          </ActionIcon>
        )}
      </span>
      {/*
       * Скрытая подпись — доступное имя checkbox; на touch она растягивается на область
       * 44×44px вокруг квадрата. Клик внутри не выбирает узел дерева и не уводит фокус.
       */}
      <Checkbox
        checked={isEnabled}
        label={<VisuallyHidden>Реализует {item.name}</VisuallyHidden>}
        onChange={(event) => onToggle(feature.id, scenario?.id, event.currentTarget.checked)}
        onKeyDown={(event) => {
          if (event.key === " ") event.stopPropagation();
        }}
        wrapperProps={{ onClick: (event) => event.stopPropagation() }}
        className={styles.checkbox}
        classNames={{ labelWrapper: styles.checkboxLabelWrapper, label: styles.checkboxLabel }}
      />
      <UnstyledButton
        className={styles.label}
        aria-pressed={isCurrent}
        onClick={(event) => {
          event.stopPropagation();
          onInspect(feature.id, scenario?.id);
        }}
      >
        <span className={clsx(styles.name, isFeature && styles._feature)}>{item.name}</span>
        <ProductKey value={item.key} />
        {isFeature && (
          <span className={styles.meta}>
            Сценарии: {selectedCount} из {feature.scenarios.length}
          </span>
        )}
        {needsDescription && <span className={styles.missing}>Нужно описание вклада</span>}
      </UnstyledButton>
      {isEnabled && <ProductReadiness status={item.status} isCompact />}
      {hasScenarioSelection && (
        <ActionIcon
          variant="subtle"
          size="sm"
          className={styles.touchControl}
          title="Выбрать все сценарии"
          aria-label={`Выбрать все сценарии: ${feature.name}`}
          onClick={(event) => {
            event.stopPropagation();
            onSelectAll(feature.id);
            tree.expand(feature.id);
          }}
        >
          <ListChecks size={15} aria-hidden="true" />
        </ActionIcon>
      )}
    </div>
  );
};
