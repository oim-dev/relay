import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ReactFlow, Background, Panel } from "@xyflow/react";
import type { ReactFlowInstance, NodeChange, EdgeChange } from "@xyflow/react";
import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Text,
  Tooltip,
  useComputedColorScheme,
} from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { Focus, LocateFixed, Maximize, Minus, Plus, RotateCcw } from "lucide-react";
import { isDefined, isNonEmptyArray } from "shared/value-predicates";
import { useContextLayout } from "./hooks/use-context-layout.hook";
import { buildContextFlow } from "./helpers/build-context-flow";
import {
  CONTEXT_ARIA_LABELS,
  CONTEXT_CAMERA_INSET,
  CONTEXT_NODE_SIZE,
} from "./config/context-canvas.config";
import { ContextNode } from "./ui/context-node/context-node";
import { ContextEdge } from "./ui/context-edge/context-edge";
import { ContextPortsSync } from "./ui/context-ports-sync/context-ports-sync";
import type { ContextFlowNode, ContextFlowEdge } from "./types/context-flow.type";
import type { ContextCanvasProps } from "./types/context-canvas-props.type";
import "@xyflow/react/dist/style.css";
import styles from "./styles/context-canvas.module.css";

/** Стабильные регистрации renderer не пересоздают узлы при выделении. */
const NODE_TYPES = { context: ContextNode };
/** Сохранённые петли и параллельные связи имеют собственный renderer. */
const EDGE_TYPES = { context: ContextEdge };

/**
 * Размещает граф и управляет камерой независимо от предметного чтения.
 *
 * Используется для:
 *  - послойной раскладки и локального перемещения карточек
 *  - выбора узлов и рёбер мышью или клавиатурой
 */
export const ContextCanvas = (props: ContextCanvasProps) => {
  const {
    nodes,
    edges,
    root,
    view,
    direction,
    selectedNodeId,
    selectedEdgeId,
    pathEdgeIds,
    boundaryIds,
    onNodeSelect,
    onEdgeSelect,
    className,
    ...rootAttrs
  } = props;
  const layout = useContextLayout(nodes, edges, root, selectedNodeId, view, direction);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const colorScheme = useComputedColorScheme("light");
  const [instance, setInstance] = useState<ReactFlowInstance<
    ContextFlowNode,
    ContextFlowEdge
  > | null>(null);
  const hasCentered = useRef(false);
  const revealedNodeId = useRef(selectedNodeId);
  const shouldReduceMotion = useReducedMotion();
  const flow = useMemo(
    () =>
      buildContextFlow(
        {
          nodes,
          edges,
          root,
          view,
          direction,
          selectedNodeId,
          selectedEdgeId,
          pathEdgeIds,
          boundaryIds,
          onNodeSelect,
          onEdgeSelect,
        },
        layout.layout,
        hoveredEdgeId,
      ),
    [
      nodes,
      edges,
      root,
      view,
      direction,
      selectedNodeId,
      selectedEdgeId,
      pathEdgeIds,
      boundaryIds,
      onNodeSelect,
      onEdgeSelect,
      layout.layout,
      hoveredEdgeId,
    ],
  );

  /**
   * Возвращает камеру к исходному узлу, не сбрасывая раскрытие и локальную раскладку.
   */
  const handleCenter = useCallback((): void => {
    const position = layout.layout.nodes.get(root)?.position;
    if (!isDefined(instance) || !isDefined(position)) return;
    const zoom = 0.85;
    void instance.setViewport({
      x: 32 - position.x * zoom,
      y:
        (canvasRef.current?.clientHeight ?? 470) / 2 -
        (position.y + CONTEXT_NODE_SIZE.height / 2) * zoom,
      zoom,
    });
  }, [instance, layout.layout.nodes, root]);

  /**
   * Возвращает выбранную карточку в читаемый масштаб после обзора большой области.
   */
  const handleFocus = (): void => {
    const position = layout.layout.nodes.get(selectedNodeId ?? root)?.position;
    if (!instance || !position) return;
    void instance.setCenter(
      position.x + CONTEXT_NODE_SIZE.width / 2,
      position.y + CONTEXT_NODE_SIZE.height / 2,
      { zoom: 0.9 },
    );
  };

  useEffect(() => {
    if (hasCentered.current || layout.isPending || !instance || !layout.layout.nodes.has(root))
      return;
    const frame = requestAnimationFrame(() => {
      handleCenter();
      hasCentered.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [instance, layout.isPending, layout.layout.nodes, root, handleCenter]);

  /*
   * Выбранная карточка, частично скрытая краем полотна, панелью камеры или легендой,
   * сдвигается в видимую область на минимальное расстояние без смены масштаба.
   */
  useEffect(() => {
    if (!hasCentered.current || !isDefined(instance) || selectedNodeId === null) return;
    if (revealedNodeId.current === selectedNodeId) return;
    const position = layout.layout.nodes.get(selectedNodeId)?.position;
    const canvas = canvasRef.current;
    if (!isDefined(position) || canvas === null) return;
    revealedNodeId.current = selectedNodeId;
    const viewport = instance.getViewport();
    const left = position.x * viewport.zoom + viewport.x;
    const top = position.y * viewport.zoom + viewport.y;
    const width = CONTEXT_NODE_SIZE.width * viewport.zoom;
    const height = CONTEXT_NODE_SIZE.height * viewport.zoom;
    const maxLeft = canvas.clientWidth - CONTEXT_CAMERA_INSET.right - width;
    const maxTop = canvas.clientHeight - CONTEXT_CAMERA_INSET.bottom - height;
    // Если карточка не помещается целиком, видимым остаётся её начало: ключ и заголовок.
    const nextLeft = Math.max(CONTEXT_CAMERA_INSET.left, Math.min(left, maxLeft));
    const nextTop = Math.max(CONTEXT_CAMERA_INSET.top, Math.min(top, maxTop));
    if (nextLeft === left && nextTop === top) return;
    void instance.setViewport(
      { x: viewport.x + nextLeft - left, y: viewport.y + nextTop - top, zoom: viewport.zoom },
      { duration: shouldReduceMotion ? 0 : 200 },
    );
  }, [instance, layout.layout.nodes, selectedNodeId, shouldReduceMotion]);

  /**
   * Разрешает только локальную геометрию и выбор; удаление и подключение отсутствуют.
   */
  const handleNodesChange = (changes: NodeChange<ContextFlowNode>[]): void => {
    const moves = changes.flatMap((change) =>
      change.type === "position" && isDefined(change.position)
        ? [{ id: change.id, position: change.position }]
        : [],
    );
    if (isNonEmptyArray(moves)) layout.onMove(moves);
    const selection = changes.find((change) => change.type === "select" && change.selected);
    if (isDefined(selection) && selection.type === "select") onNodeSelect(selection.id);
  };

  /**
   * Поддерживает клавиатурный выбор линий средствами React Flow.
   */
  const handleEdgesChange = (changes: EdgeChange<ContextFlowEdge>[]): void => {
    const selection = changes.find((change) => change.type === "select" && change.selected);
    if (isDefined(selection) && selection.type === "select") onEdgeSelect(selection.id);
  };
  const hasError = layout.error !== null;
  const isCameraDisabled = !isDefined(instance) || layout.isPending;
  const canFocusSelection = !isCameraDisabled && selectedNodeId !== null;
  const isTree = view === "tree";
  const regionLabel = isTree ? "Дерево контекста" : "Граф контекста";
  const additionalCount = edges.length - layout.layout.edges.size;
  const hasAdditionalRelations = isTree && additionalCount > 0 && !layout.isPending;
  const portsSignature = flow.nodes
    .map(
      (node) =>
        `${node.id};${node.data.ports.map((port) => `${port.id}:${port.position}:${port.x}:${port.y}`).join(",")}`,
    )
    .join("|");

  return (
    <div
      {...rootAttrs}
      ref={canvasRef}
      className={clsx(styles.root, className)}
      aria-label={regionLabel}
      role="region"
    >
      <ReactFlow<ContextFlowNode, ContextFlowEdge>
        nodes={flow.nodes}
        edges={flow.edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onInit={setInstance}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onNodeClick={(_event, node) => onNodeSelect(node.id)}
        onEdgeClick={(_event, edge) => onEdgeSelect(edge.id)}
        onEdgeMouseEnter={(_event, edge) => setHoveredEdgeId(edge.id)}
        onEdgeMouseLeave={() => setHoveredEdgeId(null)}
        nodesDraggable={!isTree}
        nodesConnectable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        minZoom={0.08}
        maxZoom={1.8}
        colorMode={colorScheme}
        ariaLabelConfig={CONTEXT_ARIA_LABELS}
        onlyRenderVisibleElements
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
      >
        <Background gap={22} size={1} color="var(--tasks-border)" />
        <ContextPortsSync signature={portsSignature} />
        <Panel position="top-left" className={styles.panel}>
          <Group gap={4}>
            <Tooltip
              label="К исходной сущности"
              events={{ hover: true, focus: true, touch: false }}
            >
              <ActionIcon
                variant="default"
                size="lg"
                aria-label="К исходной сущности"
                disabled={isCameraDisabled}
                onClick={handleCenter}
              >
                <Focus size={18} aria-hidden="true" />
              </ActionIcon>
            </Tooltip>
            <Tooltip
              label="К выбранной сущности"
              events={{ hover: true, focus: true, touch: false }}
            >
              <ActionIcon
                variant="default"
                size="lg"
                aria-label="К выбранной сущности"
                disabled={!canFocusSelection}
                onClick={handleFocus}
              >
                <LocateFixed size={18} aria-hidden="true" />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Вписать в экран" events={{ hover: true, focus: true, touch: false }}>
              <ActionIcon
                variant="default"
                size="lg"
                aria-label="Вписать в экран"
                disabled={isCameraDisabled}
                onClick={() => void instance?.fitView({ padding: 0.18, maxZoom: 1 })}
              >
                <Maximize size={18} aria-hidden="true" />
              </ActionIcon>
            </Tooltip>
            <ActionIcon
              variant="default"
              size="lg"
              aria-label="Увеличить масштаб"
              disabled={isCameraDisabled}
              onClick={() => void instance?.zoomIn()}
            >
              <Plus size={18} aria-hidden="true" />
            </ActionIcon>
            <ActionIcon
              variant="default"
              size="lg"
              aria-label="Уменьшить масштаб"
              disabled={isCameraDisabled}
              onClick={() => void instance?.zoomOut()}
            >
              <Minus size={18} aria-hidden="true" />
            </ActionIcon>
            <Tooltip
              label="Восстановить раскладку"
              events={{ hover: true, focus: true, touch: false }}
            >
              <ActionIcon
                variant="default"
                size="lg"
                aria-label="Восстановить раскладку"
                disabled={isCameraDisabled}
                onClick={layout.onRetry}
              >
                <RotateCcw size={18} aria-hidden="true" />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Panel>
        {layout.isPending && (
          <Panel position="top-right">
            <Text size="xs" role="status" className={styles.notice}>
              Рассчитываем расположение…
            </Text>
          </Panel>
        )}
        {hasError && (
          <Panel position="top-right">
            <Alert color="danger" title="Ошибка раскладки" maw={320}>
              {layout.error}
              <Button variant="subtle" color="gray" size="xs" mt="xs" onClick={layout.onRetry}>
                Повторить раскладку
              </Button>
            </Alert>
          </Panel>
        )}
        <Panel position="bottom-left" className={styles.legend}>
          <span className={styles.origin}>Исходная</span>
          <span className={styles.selected}>Выбранная / путь</span>
          {hasAdditionalRelations && (
            <span title="Сохранённые связи вне основных путей дерева. Выберите сущность для просмотра.">
              Доп. связей: {additionalCount} · в сведениях
            </span>
          )}
        </Panel>
      </ReactFlow>
    </div>
  );
};
