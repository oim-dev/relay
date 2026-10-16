import clsx from "clsx";
import { useMemo } from "react";
import { Button, Text, Tree, useTree, VisuallyHidden } from "@mantine/core";
import type { ReactNode } from "react";
import type { RenderTreeNodePayload } from "@mantine/core";
import { ChevronsDown, ChevronsUp, ListChecks, Plus } from "lucide-react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { ProductReadiness, useProductDemo } from "domains/product-demo";
import { useProductPath } from "compositions/widgets/product-page";
import { SectionPanel } from "ui/section-panel";
import { isEmptyArray } from "shared/value-predicates";
import { ApplicationFeature } from "./ui/application-feature/application-feature";
import { createApplicationTree } from "./helpers/create-application-tree";
import type { ApplicationFeaturesProps } from "./types/application-features-props.type";
import styles from "./styles/application-features.module.css";

/**
 * Собирает выбранные фичи приложения и описания его участия в сценариях.
 *
 * Используется для:
 *  - чтения состава реализации и перехода к его настройке
 */
export const ApplicationFeatures = (props: ApplicationFeaturesProps) => {
  const { applicationId, className, ...rootAttrs } = props;
  const { snapshot } = useProductDemo();
  const base = useProductPath();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const openIds = searchParams.getAll("open");
  const treeData = useMemo(
    () =>
      createApplicationTree(
        snapshot.features,
        snapshot.contributions.filter((entry) => entry.applicationId === applicationId),
      ),
    [snapshot.features, snapshot.contributions, applicationId],
  );
  const hasNoFeatures = isEmptyArray(treeData.nodes);
  const hasFeatures = !hasNoFeatures;
  const expandedState = Object.fromEntries(
    treeData.nodes.map((node) => [node.value, openIds.includes(node.value)]),
  );
  const hasExpanded = treeData.nodes.some(
    (node) => !isEmptyArray(node.children) && expandedState[node.value],
  );
  const canExpand = treeData.nodes.some((node) => !isEmptyArray(node.children));
  const toggleLabel = hasExpanded ? "Свернуть все" : "Раскрыть все";
  const ToggleIcon = hasExpanded ? ChevronsUp : ChevronsDown;
  const returnTo = `${location.pathname}${location.search}#application-features`;
  /**
   * Сохраняет раскрытие для возвращения из исходного продуктового описания.
   */
  const handleExpanded = (expanded: Record<string, boolean>): void => {
    const next = new URLSearchParams(searchParams);
    next.delete("open");
    treeData.nodes
      .filter((node) => expanded[node.value])
      .forEach((node) => next.append("open", node.value));
    if (next.toString() !== searchParams.toString())
      setSearchParams(next, { replace: true, preventScrollReset: true });
  };
  const tree = useTree({ expandedState, onExpandedStateChange: handleExpanded });
  /**
   * Переключает все ветки одним контекстным действием.
   */
  const handleToggleAll = (): void => {
    if (hasExpanded) tree.collapseAllNodes();
    else tree.expandAllNodes();
  };
  /**
   * Передаёт узел в общую строку дерева через адаптер приложения.
   */
  const renderNode = (payload: RenderTreeNodePayload): ReactNode => {
    const entry = treeData.entries.get(payload.node.value);
    if (entry === undefined) return null;
    return <ApplicationFeature {...entry} applicationId={applicationId} payload={payload} />;
  };
  return (
    <SectionPanel
      {...rootAttrs}
      id="application-features"
      tabIndex={-1}
      className={clsx(styles.root, className)}
      density="compact"
      title="Реализуемые фичи и сценарии"
      count={
        <>
          <VisuallyHidden>Фич: </VisuallyHidden>
          {treeData.nodes.length}
        </>
      }
      description="Готовность обновляется по задачам. Откройте фичу или сценарий, чтобы увидеть описание и ход реализации."
      actions={
        <Button
          component={Link}
          to={`${base}/applications/${applicationId}/scope`}
          state={{ returnTo }}
          leftSection={<ListChecks size={15} aria-hidden="true" />}
        >
          Выбрать фичи и сценарии
        </Button>
      }
    >
      {hasNoFeatures && (
        <div className={styles.empty}>
          <Plus size={22} aria-hidden="true" />
          <Text fw={600}>Определите, что реализует приложение</Text>
          <Text size="sm" c="dimmed">
            Выберите фичи и сценарии из продукта, затем опишите вклад в каждый выбранный элемент.
          </Text>
        </div>
      )}
      {hasFeatures && (
        <>
          <div className={styles.toolbar}>
            <div
              className={styles.legend}
              role="group"
              aria-label="Готовность реализации в приложении"
            >
              <ProductReadiness status="done" label="Реализовано" />
              <ProductReadiness status="partial" label="В работе" />
              <ProductReadiness status="none" label="Не реализовано" />
            </div>
            <Button
              size="compact-sm"
              variant="default"
              leftSection={<ToggleIcon size={14} aria-hidden="true" />}
              onClick={handleToggleAll}
              disabled={!canExpand}
            >
              {toggleLabel}
            </Button>
          </div>
          <Tree
            data={treeData.nodes}
            tree={tree}
            levelOffset={0}
            expandOnClick
            renderNode={renderNode}
            aria-label="Фичи и сценарии приложения"
            onKeyDownCapture={(event) => {
              if (
                event.key !== "Enter" ||
                !(event.target instanceof HTMLElement) ||
                event.target.getAttribute("role") !== "treeitem"
              )
                return;
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
        </>
      )}
    </SectionPanel>
  );
};
