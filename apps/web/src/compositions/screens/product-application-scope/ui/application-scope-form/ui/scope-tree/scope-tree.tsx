import clsx from "clsx";
import { useMemo, useState } from "react";
import { SegmentedControl, Text, TextInput, Tree, useTree } from "@mantine/core";
import type { ReactNode } from "react";
import type { RenderTreeNodePayload } from "@mantine/core";
import { Search } from "lucide-react";
import { isEmptyArray } from "shared/value-predicates";
import { ScopeNode } from "./ui/scope-node/scope-node";
import { createScopeTree } from "./helpers/create-scope-tree";
import type { ScopeTreeProps } from "./types/scope-tree-props.type";
import styles from "./styles/scope-tree.module.css";

/**
 * Даёт выбрать фичи и сценарии и открыть нужное описание вклада.
 *
 * Используется для:
 *  - поиска по каталогу и просмотра выбранного состава без потери скрытого ввода
 */
export const ScopeTree = (props: ScopeTreeProps) => {
  const {
    items,
    activeFeatureId,
    activeScenarioId,
    onInspect,
    onToggle,
    onSelectAll,
    className,
    ...rootAttrs
  } = props;
  const [query, setQuery] = useState("");
  const [view, setView] = useState("all");
  const treeData = useMemo(
    () => createScopeTree(items, query, view === "selected"),
    [items, query, view],
  );
  const tree = useTree({
    initialExpandedState: activeFeatureId === undefined ? {} : { [activeFeatureId]: true },
  });
  const hasNoResults = isEmptyArray(treeData.nodes);
  /**
   * Раскрывает совпадения, сохраняя состав и описания формы.
   */
  const handleSearch = (nextQuery: string): void => {
    setQuery(nextQuery);
    if (nextQuery.trim() !== "")
      tree.setExpandedState(Object.fromEntries(items.map((entry) => [entry.id, true])));
  };
  /**
   * Заполняет публичный слот узла подготовленной проекцией.
   */
  const renderNode = (payload: RenderTreeNodePayload): ReactNode => {
    const entry = treeData.entries.get(payload.node.value);
    if (entry === undefined) return null;
    const isCurrent =
      entry.feature.id === activeFeatureId && entry.scenario?.id === activeScenarioId;
    return (
      <ScopeNode
        entry={entry}
        payload={payload}
        isCurrent={isCurrent}
        onInspect={onInspect}
        onToggle={onToggle}
        onSelectAll={onSelectAll}
      />
    );
  };
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <div className={styles.controls}>
        <h2 className={styles.title}>1. Выберите состав</h2>
        <Text size="sm" c="dimmed">
          Чекбокс включает в реализацию. Название открывает описание вклада.
        </Text>
        <TextInput
          type="search"
          aria-label="Найти фичу или сценарий для приложения"
          placeholder="Найти фичу или сценарий…"
          value={query}
          onChange={(event) => handleSearch(event.currentTarget.value)}
          leftSection={<Search size={15} aria-hidden="true" />}
        />
        <SegmentedControl
          aria-label="Показать состав"
          size="xs"
          fullWidth
          value={view}
          onChange={setView}
          data={[
            { value: "all", label: "Все фичи" },
            { value: "selected", label: "Выбранные" },
          ]}
        />
      </div>
      <div className={styles.items}>
        {hasNoResults && (
          <Text size="sm" c="dimmed" role="status" className={styles.noResults}>
            Нет подходящих элементов. Измените поиск или покажите все фичи.
          </Text>
        )}
        <Tree
          data={treeData.nodes}
          tree={tree}
          levelOffset="md"
          expandOnClick={false}
          renderNode={renderNode}
          aria-label="Выбор фич и сценариев приложения"
          onKeyDownCapture={(event) => {
            if (
              event.key !== "Enter" ||
              !(event.target instanceof HTMLElement) ||
              event.target.getAttribute("role") !== "treeitem"
            )
              return;
            const entry = treeData.entries.get(event.target.dataset.value ?? "");
            if (entry === undefined) return;
            event.preventDefault();
            event.stopPropagation();
            onInspect(entry.feature.id, entry.scenario?.id);
          }}
        />
      </div>
    </div>
  );
};
