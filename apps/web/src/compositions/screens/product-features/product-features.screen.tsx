import { useMemo, useState } from "react";
import { useProjectId } from "domains/project";
import { useFeatureExpansion } from "domains/product";
import {
  Button,
  NativeSelect,
  Text,
  TextInput,
  Tree,
  useTree,
  VisuallyHidden,
} from "@mantine/core";
import type { ReactNode } from "react";
import type { RenderTreeNodePayload } from "@mantine/core";
import { ChevronsDown, ChevronsUp, Plus, Search, X } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import {
  getFeatureStatus,
  PRODUCT_STATUS_OPTIONS,
  ProductReadiness,
  useProductDemo,
} from "domains/product-demo";
import { ProductPage, useProductPath } from "compositions/widgets/product-page";
import { SectionPanel } from "ui/section-panel";
import { StatePanel } from "ui/state-panel";
import { isEmptyArray } from "shared/value-predicates";
import { FeatureRow } from "./ui/feature-row";
import { createFeatureTree } from "./helpers/create-feature-tree";
import styles from "./styles/product-features.module.css";

/**
 * Представляет двухуровневое дерево возможностей и сценариев с фильтрами в URL.
 *
 * Используется для:
 *  - поиска фич и восстановления выбранного списка после просмотра карточки
 */
export const ProductFeaturesScreen = () => {
  const { snapshot, mode, setMode } = useProductDemo();
  const base = useProductPath();
  const projectId = useProjectId();
  const expansion = useFeatureExpansion(projectId);
  const [searchExpansion, setSearchExpansion] = useState<{
    query: string;
    values: Record<string, boolean>;
  }>({ query: "", values: {} });
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const status = searchParams.get("status") ?? "";
  const applicationId = searchParams.get("app") ?? "";
  const normalizedQuery = query.trim().toLocaleLowerCase("ru");
  const hasFilters = query !== "" || status !== "" || applicationId !== "";
  const hasNoFeatures = isEmptyArray(snapshot.features);
  const applicationOptions = snapshot.applications.map((application) => ({
    value: application.id,
    label: application.name,
  }));
  const treeData = useMemo(() => {
    const features = snapshot.features.filter((feature) => {
      const matchesStatus = status === "" || getFeatureStatus(feature) === status;
      const matchesApplication =
        applicationId === "" ||
        snapshot.contributions.some(
          (link) => link.featureId === feature.id && link.applicationId === applicationId,
        );
      return matchesStatus && matchesApplication;
    });
    return createFeatureTree(features, normalizedQuery);
  }, [snapshot.features, snapshot.contributions, status, applicationId, normalizedQuery]);
  const hasNoResults = !hasNoFeatures && isEmptyArray(treeData.nodes);
  const hasTree = !hasNoFeatures && !hasNoResults;
  const shouldExpandByDefault = normalizedQuery !== "";
  const searchValues = searchExpansion.query === normalizedQuery ? searchExpansion.values : {};
  const expandedState = Object.fromEntries(
    treeData.nodes.map((node) => [
      node.value,
      shouldExpandByDefault
        ? (searchValues[node.value] ?? true)
        : (expansion.expanded[node.value] ?? false),
    ]),
  );
  /**
   * Меняет только состояние дерева проекта, без навигации и повторного открытия экрана.
   */
  const handleExpandedChange = (nextExpanded: Record<string, boolean>): void => {
    const nextValues = { ...(shouldExpandByDefault ? searchValues : expansion.expanded) };
    for (const node of treeData.nodes) {
      const isExpanded = nextExpanded[node.value] === true;
      nextValues[node.value] = isExpanded;
    }
    if (shouldExpandByDefault) setSearchExpansion({ query: normalizedQuery, values: nextValues });
    else expansion.setExpanded(nextValues);
  };
  const tree = useTree({ expandedState, onExpandedStateChange: handleExpandedChange });
  const hasExpandableNodes = treeData.nodes.some((node) => !isEmptyArray(node.children));
  const hasExpandedNodes = treeData.nodes.some(
    (node) => !isEmptyArray(node.children) && expandedState[node.value],
  );
  const toggleAllLabel = hasExpandedNodes ? "Свернуть все" : "Раскрыть все";
  const ToggleAllIcon = hasExpandedNodes ? ChevronsUp : ChevronsDown;
  /**
   * Переключает видимые ветки одним контекстным действием.
   */
  const handleToggleAll = (): void => {
    if (hasExpandedNodes) tree.collapseAllNodes();
    else tree.expandAllNodes();
  };
  const filterParams = new URLSearchParams(searchParams);
  filterParams.delete("open");
  filterParams.delete("closed");
  const filterSearch = filterParams.size > 0 ? `?${filterParams.toString()}` : "";
  /**
   * Обновляет один фильтр без отдельных записей истории на каждый символ.
   */
  const handleFilter = (name: string, selection: string): void => {
    const nextParams = new URLSearchParams(searchParams);
    if (selection === "") nextParams.delete(name);
    else nextParams.set(name, selection);
    nextParams.delete("closed");
    nextParams.delete("open");
    if (mode === "no-results") setMode("filled");
    setSearchParams(nextParams, { replace: true, preventScrollReset: true });
  };
  /**
   * Возвращает полный каталог.
   */
  const handleClear = (): void => {
    if (mode === "no-results") setMode("filled");
    setSearchParams({}, { replace: true, preventScrollReset: true });
  };
  /**
   * Передаёт подготовленные данные в публичный слот визуализации узла Mantine.
   */
  const renderNode = (payload: RenderTreeNodePayload): ReactNode => {
    const entry = treeData.entries.get(payload.node.value);
    if (entry === undefined) return null;
    return <FeatureRow {...entry} payload={payload} search={filterSearch} />;
  };
  const catalogStatus = hasFilters
    ? `Показано ${treeData.nodes.length} из ${snapshot.features.length} по условиям поиска.`
    : "Откройте фичу, чтобы прочитать описание, сценарии и задачи реализации.";
  const filterControls = (
    <div className={styles.filters} role="search" aria-label="Поиск и фильтры фич">
      <TextInput
        type="search"
        aria-label="Найти фичу или сценарий"
        placeholder="Найти фичу или сценарий…"
        value={query}
        onChange={(event) => handleFilter("q", event.currentTarget.value)}
        leftSection={<Search size={16} aria-hidden="true" />}
        className={styles.search}
      />
      <NativeSelect
        aria-label="Готовность фичи"
        value={status}
        data={[{ value: "", label: "Любая готовность" }, ...PRODUCT_STATUS_OPTIONS]}
        onChange={(event) => handleFilter("status", event.currentTarget.value)}
        className={styles.filter}
      />
      <NativeSelect
        aria-label="Приложение"
        value={applicationId}
        data={[{ value: "", label: "Все приложения" }, ...applicationOptions]}
        onChange={(event) => handleFilter("app", event.currentTarget.value)}
        className={styles.filter}
      />
    </div>
  );
  const createAction = (
    <Button
      component={Link}
      to={`${base}/features/new`}
      leftSection={<Plus size={15} aria-hidden="true" />}
      className={styles.create}
    >
      Добавить фичу
    </Button>
  );
  return (
    <ProductPage
      title="Возможности"
      description="Возможности продукта и их сценарии. Фича готова, когда готовы все её сценарии."
      actionsLayout="toolbar"
      actions={
        <>
          {filterControls}
          {createAction}
        </>
      }
    >
      {!expansion.canPersist && (
        <Text size="xs" c="dimmed" role="status">
          Раскрытие сохранено до закрытия страницы: браузерное хранилище недоступно.
        </Text>
      )}
      {hasNoFeatures && (
        <StatePanel
          title="Фич пока нет"
          description="Добавьте первую возможность продукта. Её можно описать заранее, даже если план и задачи ещё не созданы."
          action={
            <Button component={Link} to={`${base}/features/new`} variant="default">
              Добавить первую фичу
            </Button>
          }
        />
      )}
      {hasNoResults && (
        <StatePanel
          title="Фичи не найдены"
          description="Попробуйте другое название или измените фильтры. В каталоге есть фичи, но они не подходят под эти условия."
          action={
            <Button variant="default" onClick={handleClear}>
              Показать все фичи
            </Button>
          }
        />
      )}
      {hasTree && (
        <SectionPanel
          title="Фичи и сценарии"
          density="compact"
          count={
            <>
              <VisuallyHidden>Фич: </VisuallyHidden>
              {treeData.nodes.length}
            </>
          }
          description={<span role="status">{catalogStatus}</span>}
          actions={
            <>
              {hasFilters && (
                <Button
                  size="compact-sm"
                  variant="subtle"
                  leftSection={<X size={14} aria-hidden="true" />}
                  onClick={handleClear}
                >
                  Сбросить фильтры
                </Button>
              )}
              <Button
                size="compact-sm"
                variant="default"
                leftSection={<ToggleAllIcon size={14} aria-hidden="true" />}
                onClick={handleToggleAll}
                disabled={!hasExpandableNodes}
              >
                {toggleAllLabel}
              </Button>
            </>
          }
        >
          <div className={styles.legend} role="group" aria-label="Обозначения готовности">
            <ProductReadiness status="done" />
            <ProductReadiness status="partial" />
            <ProductReadiness status="none" />
          </div>
          <Tree
            data={treeData.nodes}
            tree={tree}
            levelOffset={0}
            expandOnClick
            aria-label="Фичи и сценарии"
            renderNode={renderNode}
            className={styles.tree}
            onKeyDownCapture={(event) => {
              if (event.key !== "Enter" || !(event.target instanceof HTMLElement)) return;
              if (event.target.getAttribute("role") !== "treeitem") return;
              event.preventDefault();
              event.stopPropagation();
              const entry = treeData.entries.get(event.target.dataset.value ?? "");
              if (entry !== undefined && entry.scenario === undefined) {
                tree.toggleExpanded(entry.feature.id);
                return;
              }
              event.target.querySelector<HTMLAnchorElement>("a[data-tree-link]")?.click();
            }}
          />
        </SectionPanel>
      )}
    </ProductPage>
  );
};
