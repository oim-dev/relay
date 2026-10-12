import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Drawer, Group, Loader, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { Info, RefreshCw } from "lucide-react";
import {
  relationAddress,
  useRelationDiagram,
  RELATION_DIAGRAM_MAX_PAGES,
  RELATION_DIAGRAM_PAGE_SIZE,
} from "domains/relations";
import type { RelationDiagramRequest } from "domains/relations";
import { StatePanel } from "ui/state-panel";
import { StatusBadge } from "ui/status-badge";
import { isDefined, isEmptyArray, isNonEmptyArray } from "shared/value-predicates";
import { ContextCanvas } from "../context-canvas";
import { ContextInspector } from "../context-inspector/context-inspector";
import { ContextList } from "../context-list/context-list";
import { findContextPath } from "../../helpers/find-context-path";
import type { ContextExplorerProps } from "./types/context-explorer-props.type";
import styles from "./styles/context-explorer.module.css";

/**
 * Координирует один ограниченный снимок, выбранный элемент и раскрытые области.
 *
 * Используется для:
 *  - продолжения страниц с сохранением версии
 *  - исследования диаграммы и полного содержания выбранной сущности
 */
export const ContextExplorer = ({
  projectId,
  root,
  options,
  mode,
  onRoot,
  onTypes,
}: ContextExplorerProps) => {
  const [request, setRequest] = useState<RelationDiagramRequest>({
    root,
    direction: options.direction,
    type: options.type,
    regions: [{ root, depth: options.depth, pages: 1 }],
  });
  const [refreshKey, setRefreshKey] = useState(0);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [edgeId, setEdgeId] = useState<string | null>(null);
  const [isPathShown, setPathShown] = useState(false);
  const [isInspectorOpen, setInspectorOpen] = useState(false);
  const [canvasView, setCanvasView] = useState<"tree" | "graph">(
    mode === "graph" ? "graph" : "tree",
  );
  useEffect(() => {
    if (mode !== "list") setCanvasView(mode);
  }, [mode]);
  const isWide = useMediaQuery("(min-width: 75em)");
  const query = useRelationDiagram(projectId, request, refreshKey);
  const graph = query.data;
  useEffect(() => {
    if (graph) onTypes([...new Set(graph.edges.map((edge) => edge.type))]);
  }, [graph, onTypes]);
  const rootAddress = graph ? relationAddress(graph.root.ref) : root;
  const selectedNodeId = edgeId === null ? (nodeId ?? rootAddress) : null;
  const selectedNode = graph?.nodes.find((node) => relationAddress(node.ref) === selectedNodeId);
  const selectedEdge = graph?.edges.find((edge) => edge.id === edgeId);
  const hasGraph = isDefined(graph);
  const hasError = isDefined(query.error);
  const isBusy = query.isValidating || hasError;
  const pageCount = request.regions.reduce((count, region) => count + region.pages, 0);
  const hasBudget = pageCount < RELATION_DIAGRAM_MAX_PAGES;
  const canExpand =
    isDefined(selectedNode) &&
    selectedNodeId !== rootAddress &&
    hasBudget &&
    !request.regions.some((region) => region.root === selectedNodeId);
  const isRoot = selectedNodeId === rootAddress;
  const path =
    graph && selectedNodeId ? findContextPath(graph, selectedNodeId, options.direction) : null;
  const pathEdgeIds = isPathShown ? (path?.edges ?? []) : [];
  const pathLabel = path?.nodes
    .map(
      (address) =>
        graph?.nodes.find((node) => relationAddress(node.ref) === address)?.key ?? address,
    )
    .join(" — ");
  const hasPath = path !== null;
  const hasPathLabel = isPathShown && hasPath;
  const continuationItems = (graph?.regions ?? [])
    .filter((region) => region.nextOffset !== null)
    .map((region) => ({
      ...region,
      label:
        graph?.nodes.find((node) => relationAddress(node.ref) === region.root)?.key ??
        graph?.root.key ??
        region.root,
    }));
  const hasMore = isNonEmptyArray(continuationItems);
  const hasDepthBoundary = graph?.regions.some((region) => region.isDepthLimited) ?? false;
  const isCompleteArea = hasGraph && !hasMore && !hasDepthBoundary;
  const isEmpty = hasGraph && isEmptyArray(graph.edges) && !hasMore;
  const isFiltered = options.type !== undefined || options.direction !== "both";
  const emptyLabel = isFiltered ? "В выбранных условиях связей нет" : "Связей пока нет";
  const isDiagram = mode !== "list";
  const isTree = mode === "tree";
  const isList = mode === "list";
  const hasNoGraphLoading = !hasGraph && query.isLoading;
  const hasNoBudget = !hasBudget;
  const isMobileInspector = !isWide;
  const isDrawerOpen = isMobileInspector && isInspectorOpen;

  /**
   * Начинает новый согласованный снимок всех раскрытых областей, сохраняя выбор.
   */
  const handleRefresh = (): void => {
    setRequest((current) => ({ ...current, version: undefined }));
    setRefreshKey((key) => key + 1);
  };
  /**
   * Выбирает карточку без смены исходной сущности.
   */
  const handleNodeSelect = useCallback((address: string): void => {
    setNodeId(address);
    setEdgeId(null);
    setPathShown(false);
    setInspectorOpen(true);
  }, []);
  /**
   * Открывает именно выбранное ребро, включая параллельные отношения.
   */
  const handleEdgeSelect = useCallback((id: string): void => {
    setEdgeId(id);
    setPathShown(false);
    setInspectorOpen(true);
  }, []);
  /**
   * Добавляет соседей выбранного узла в текущей версии снимка.
   */
  const handleExpand = (): void => {
    if (!graph || !selectedNodeId || !canExpand || isBusy) return;
    setRequest((current) => ({
      ...current,
      version: graph.version,
      regions: [...current.regions, { root: selectedNodeId, depth: 1, pages: 1 }],
    }));
    setInspectorOpen(false);
  };
  /**
   * Дочитывает одну область, не смешивая версии и не обрезая прежние страницы.
   */
  const handleContinue = (address: string): void => {
    if (!graph || !hasBudget || isBusy) return;
    setRequest((current) => ({
      ...current,
      version: graph.version,
      regions: current.regions.map((region) =>
        region.root === address ? { ...region, pages: region.pages + 1 } : region,
      ),
    }));
  };
  /**
   * Выделяет доступный путь и возвращает диаграмму из мобильной панели.
   */
  const handlePath = (): void => {
    setPathShown(true);
    setInspectorOpen(false);
  };
  const inspectorProps = {
    projectId,
    node: selectedNode,
    edge: selectedEdge,
    nodes: graph?.nodes ?? [],
    edges: graph?.edges ?? [],
    isRoot,
    canExpand,
    hasPath,
    isBusy,
    onExpand: handleExpand,
    onRoot,
    onPath: handlePath,
    onNodeSelect: handleNodeSelect,
    onEdgeSelect: handleEdgeSelect,
  };

  return (
    <div className={styles.root}>
      <div className={styles.summary}>
        <div className={styles.identity}>
          <Text size="xs" c="dimmed">
            Исходная · {graph?.root.key ?? root}
          </Text>
          <h2 className={styles.rootTitle}>{graph?.root.title ?? "Исходная сущность"}</h2>
          {hasGraph && (
            <Text size="xs" c="dimmed">
              Загружено: сущностей — {graph.nodes.length} · связей — {graph.edges.length}
            </Text>
          )}
        </div>
        <Group gap="xs">
          {isMobileInspector && (
            <Button
              variant="default"
              size="sm"
              leftSection={<Info size={15} aria-hidden="true" />}
              onClick={() => setInspectorOpen(true)}
              disabled={!hasGraph}
            >
              Сведения
            </Button>
          )}
          <Button
            variant="default"
            size="sm"
            leftSection={<RefreshCw size={15} aria-hidden="true" />}
            onClick={handleRefresh}
            loading={query.isValidating}
          >
            Обновить
          </Button>
        </Group>
      </div>
      {hasError && (
        <Alert color="warning" title="Не удалось обновить контекст" role="alert">
          {query.error?.message}
          {hasGraph && (
            <Text size="sm" mt="xs">
              Ниже оставлен предыдущий согласованный снимок.
            </Text>
          )}
          <Button variant="subtle" color="gray" size="xs" mt="xs" onClick={handleRefresh}>
            Повторить загрузку контекста
          </Button>
        </Alert>
      )}
      {hasNoGraphLoading && (
        <StatePanel
          state="loading"
          title="Загружаем контекст"
          description="Читаем исходную сущность и сохранённые связи."
        />
      )}
      {hasGraph && (
        <>
          <div className={styles.boundaries} role="status">
            {query.isValidating && <Loader size="xs" />}
            {hasMore && <StatusBadge tone="warning">Есть непрочитанные страницы</StatusBadge>}
            {hasDepthBoundary && (
              <Text size="xs">
                Контекст показан частично: есть связи за выбранной глубиной. Раскройте узел или
                увеличьте глубину.
              </Text>
            )}
            {isCompleteArea && <Text size="xs">Все связи в выбранных условиях загружены.</Text>}
            {hasNoBudget && (
              <Text size="xs">
                Достигнут предел: {RELATION_DIAGRAM_MAX_PAGES} страниц по{" "}
                {RELATION_DIAGRAM_PAGE_SIZE}. Сузьте область или смените исходную сущность.
              </Text>
            )}
          </div>
          {isTree && (
            <Text size="xs" c="dimmed">
              Один путь к каждой сущности. Дополнительные связи и циклы — в сведениях о выбранной
              карточке; все линии — в режиме «Граф». Стрелки сохраняют направление отношений.
            </Text>
          )}
          {isEmpty && (
            <Text size="sm" c="dimmed" role="status">
              {emptyLabel}. Исходная сущность остаётся доступна.
            </Text>
          )}
          {hasPathLabel && (
            <Alert
              color="info"
              title="Путь включения"
              withCloseButton
              onClose={() => setPathShown(false)}
              closeButtonLabel="Скрыть путь"
            >
              <Text size="sm">{pathLabel}</Text>
              <Text size="xs" mt={4}>
                Стрелки сохраняют направление отношений. Путь объясняет достижимость.
              </Text>
            </Alert>
          )}
          <div className={styles.workspace}>
            <div className={styles.main}>
              <div
                className={styles.diagram}
                data-hidden={!isDiagram}
                aria-hidden={!isDiagram}
                inert={!isDiagram}
              >
                <ContextCanvas
                  nodes={graph.nodes}
                  edges={graph.edges}
                  root={rootAddress}
                  view={canvasView}
                  direction={options.direction}
                  selectedNodeId={selectedNodeId}
                  selectedEdgeId={edgeId}
                  pathEdgeIds={pathEdgeIds}
                  boundaryIds={graph.boundary}
                  onNodeSelect={handleNodeSelect}
                  onEdgeSelect={handleEdgeSelect}
                />
              </div>
              {isList && (
                <ContextList
                  nodes={graph.nodes}
                  edges={graph.edges}
                  selectedNodeId={selectedNodeId}
                  selectedEdgeId={edgeId}
                  onNodeSelect={handleNodeSelect}
                  onEdgeSelect={handleEdgeSelect}
                />
              )}
            </div>
            {isWide && (
              <aside className={styles.inspector}>
                <ContextInspector {...inspectorProps} />
              </aside>
            )}
          </div>
          {hasMore && (
            <Group gap="xs">
              {continuationItems.map((region) => (
                <Button
                  key={region.root}
                  variant="light"
                  color="accent"
                  size="xs"
                  disabled={isBusy || !hasBudget}
                  onClick={() => handleContinue(region.root)}
                >
                  Загрузить ещё: {region.label}
                </Button>
              ))}
            </Group>
          )}
        </>
      )}
      <Drawer.Root
        opened={isDrawerOpen}
        onClose={() => setInspectorOpen(false)}
        position="right"
        size="md"
      >
        <Drawer.Overlay />
        <Drawer.Content>
          <Drawer.Header role="presentation">
            <Drawer.Title>Подробности контекста</Drawer.Title>
            <Drawer.CloseButton aria-label="Закрыть подробности" />
          </Drawer.Header>
          <Drawer.Body>
            <ContextInspector {...inspectorProps} />
          </Drawer.Body>
        </Drawer.Content>
      </Drawer.Root>
    </div>
  );
};
