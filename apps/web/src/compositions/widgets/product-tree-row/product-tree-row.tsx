import clsx from "clsx";
import { ActionIcon } from "@mantine/core";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { ProductReadiness } from "domains/product-demo";
import { ProductKey } from "domains/product";
import { isDefined } from "shared/value-predicates";
import type { ProductTreeRowProps } from "./types/product-tree-row-props.type";
import styles from "./styles/product-tree-row.module.css";

/**
 * Задаёт единые отступы, линии, состояния и переходы строки продуктового дерева.
 *
 * Используется для:
 *  - отображения общего каталога фич и состава реализации приложения
 */
export const ProductTreeRow = (props: ProductTreeRowProps) => {
  const {
    name,
    entityKey,
    summary,
    href,
    status,
    readinessLabel,
    countLabel,
    isFeature,
    isLastScenario = false,
    payload,
    sourceHref,
    sourceLabel,
    returnTo,
    className,
    ...rootAttrs
  } = props;
  const { hasChildren, expanded, tree, node, elementProps } = payload;
  const isScenario = !isFeature;
  const hasOpenBranch = isFeature && hasChildren && expanded;
  const hasSummary = summary !== undefined && summary !== "";
  const toggleLabel = `${expanded ? "Свернуть" : "Раскрыть"} сценарии: ${name}`;
  return (
    <div
      {...rootAttrs}
      {...elementProps}
      className={clsx(
        elementProps.className,
        styles.root,
        isFeature && styles._feature,
        isScenario && styles._scenario,
        hasOpenBranch && styles._expanded,
        isLastScenario && styles._last,
        className,
      )}
    >
      {isFeature && (
        <span className={styles.toggleSlot}>
          {hasChildren && (
            <ActionIcon
              variant="subtle"
              size="sm"
              aria-label={toggleLabel}
              aria-expanded={expanded}
              onKeyDown={(event) => {
                if (event.key === " " || event.key === "Enter") event.stopPropagation();
              }}
              onClick={(event) => {
                event.stopPropagation();
                tree.toggleExpanded(node.value);
              }}
            >
              <ChevronRight
                size={16}
                aria-hidden="true"
                className={clsx(styles.chevron, expanded && styles._expanded)}
              />
            </ActionIcon>
          )}
        </span>
      )}
      <div className={styles.content}>
        <div className={styles.headline}>
          <ProductReadiness status={status} isCompact label={readinessLabel} />
          <ProductKey value={entityKey} />
          <Link
            to={href}
            state={{ returnTo }}
            className={clsx(styles.title, isFeature && styles._feature)}
            onClick={(event) => event.stopPropagation()}
            data-tree-link
          >
            {name}
          </Link>
          {isDefined(countLabel) && <span className={styles.count}>{countLabel}</span>}
        </div>
        {hasSummary && <p className={styles.summary}>{summary}</p>}
      </div>
      {isDefined(sourceHref) && (
        <ActionIcon
          component={Link}
          to={sourceHref}
          state={{ returnTo }}
          variant="subtle"
          size="sm"
          className={styles.source}
          aria-label={sourceLabel}
          title={sourceLabel}
          onClick={(event) => event.stopPropagation()}
        >
          <ArrowUpRight size={15} aria-hidden="true" />
        </ActionIcon>
      )}
    </div>
  );
};
