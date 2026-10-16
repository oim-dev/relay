import clsx from "clsx";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, useComputedColorScheme } from "@mantine/core";
import { ReactFlow, PanOnScrollMode } from "@xyflow/react";
import type { ReactFlowInstance } from "@xyflow/react";
import { Circle, Minus, Plus, RefreshCw, RotateCcw } from "lucide-react";
import { useWorkGraph, WORK_HISTORY_GRAPH_CAPABILITY } from "domains/work-history";
import { isDefined, isEmptyArray } from "shared/value-predicates";
import { useHistoryElk } from "./hooks/use-history-elk.hook";
import { createHistoryElkPlan } from "./helpers/create-history-elk-plan";
import { HISTORY_ARIA_LABELS, HISTORY_DEFAULT_VIEWPORT } from "./config/history-elk.config";
import { buildHistoryFlow } from "./helpers/build-history-flow";
import { historyNodeCenter, preserveHistoryViewport } from "./helpers/preserve-history-viewport";
import { HistoryPoint } from "./ui/history-point/history-point";
import { HistoryBoundary } from "./ui/history-boundary/history-boundary";
import { HistoryDate } from "./ui/history-date/history-date";
import { HistoryAnchor } from "./ui/history-anchor/history-anchor";
import { HistoryEdge } from "./ui/history-edge/history-edge";
import { UnfinishedSessions } from "./ui/unfinished-sessions/unfinished-sessions";
import type { UnfinishedSessionItem } from "./ui/unfinished-sessions/types/unfinished-sessions-props.type";
import type { HistoryFlowNode, HistoryFlowEdge } from "./types/history-flow.type";
import type { HistoryElkSnapshot } from "./types/history-elk.type";
import type { HistoryGraphProps } from "./types/history-graph-props.type";
import "@xyflow/react/dist/style.css";
import styles from "./styles/history-graph.module.css";

/** Стабильные renderer не перемонтируют маркеры при смене URL или камеры. */
const NODE_TYPES = {
  historyPoint: HistoryPoint,
  historyBoundary: HistoryBoundary,
  historyDate: HistoryDate,
  historyAnchor: HistoryAnchor,
};
const EDGE_TYPES = { historyEdge: HistoryEdge };

/**
 * Показывает хронологию проекта в read-only React Flow с реальными позициями/routes ELK.
 *
 * Используется для:
 *  - просмотра сохранённых веток, завершений и адресных мест продолжения
 *  - сохранения читаемого масштаба, видимой точки и фокуса при SSE и продолжении страниц
 */
export const HistoryGraph = (props: HistoryGraphProps) => {
  const { projectId, selectedPoint, highlightedSession, onSelectPoint, className, ...rootAttrs } =
    props;
  const query = useWorkGraph(projectId);
  const layout = useHistoryElk(projectId, query.graph, createHistoryElkPlan);
  const snapshot = layout.snapshot;
  const canvasRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusedRef = useRef<HTMLButtonElement | null>(null);
  const restoringFocusRef = useRef(false);
  const previousSnapshotRef = useRef<HistoryElkSnapshot | null>(null);
  const [instance, setInstance] = useState<ReactFlowInstance<
    HistoryFlowNode,
    HistoryFlowEdge
  > | null>(null);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [revealedPoint, setRevealedPoint] = useState<string | null>(null);
  const colorScheme = useComputedColorScheme("light");
  const unfinishedItems = useMemo<UnfinishedSessionItem[]>(
    () =>
      snapshot?.pointOrder.flatMap((id) => {
        const marker = snapshot.nodes.get(id)?.marker;
        if (marker?.kind !== "point" || !marker.isOpenEnd) return [];
        const { status } = marker.branch;
        if (status === "completed" || status === "cancelled") return [];
        return [{ pointId: id, title: marker.branch.title, status, color: marker.color }];
      }) ?? [],
    [snapshot],
  );

  /**
   * Навигация верхней полосы подводит точку по вертикали, сохраняя горизонталь и масштаб.
   */
  const handleRevealPoint = (pointId: string): void => {
    const node = snapshot?.nodes.get(pointId);
    if (node === undefined || instance === null) return;
    const center = historyNodeCenter(node);
    const { x, zoom } = instance.getViewport();
    setRevealedPoint(pointId);
    void instance.setViewport(
      {
        x,
        y: (canvasRef.current?.clientHeight ?? 600) / 2 - center.y * zoom,
        zoom,
      },
      { duration: 0 },
    );
    const target = canvasRef.current?.querySelector<HTMLButtonElement>(
      `[data-graph-point="${CSS.escape(pointId)}"]`,
    );
    restoringFocusRef.current = true;
    target?.focus({ preventScroll: true });
    restoringFocusRef.current = false;
  };

  /**
   * Делает фокусируемый маркер видимым, не масштабируя весь длинный граф в миниатюру.
   */
  const handleFocusNode = useCallback(
    (id: string): void => {
      if (restoringFocusRef.current || snapshot === null || instance === null) return;
      const prefix = `${projectId}:`;
      if (!id.startsWith(prefix)) return;
      const node = snapshot.nodes.get(id.slice(prefix.length));
      if (node === undefined) return;
      const viewport = instance.getViewport();
      const center = historyNodeCenter(node);
      const width = canvasRef.current?.clientWidth ?? 400;
      const height = canvasRef.current?.clientHeight ?? 600;
      const screenX = center.x * viewport.zoom + viewport.x;
      const screenY = center.y * viewport.zoom + viewport.y;
      const x = screenX < 24 || screenX > width - 24 ? 48 - center.x * viewport.zoom : viewport.x;
      const y =
        screenY < 24 || screenY > height - 24 ? height / 2 - center.y * viewport.zoom : viewport.y;
      if (x !== viewport.x || y !== viewport.y)
        void instance.setViewport({ x, y, zoom: viewport.zoom }, { duration: 0 });
    },
    [instance, projectId, snapshot],
  );

  /**
   * Переводит клавиатуру по настоящим событиям, не по техническим anchor nodes.
   */
  const handleNavigate = useCallback(
    (id: string, direction: "next" | "previous" | "first" | "last"): void => {
      if (snapshot === null) return;
      const current = snapshot.pointOrder.findIndex((pointId) => `${projectId}:${pointId}` === id);
      const index =
        direction === "first"
          ? 0
          : direction === "last"
            ? snapshot.pointOrder.length - 1
            : direction === "next"
              ? current + 1
              : current - 1;
      const next = snapshot.pointOrder[index];
      if (next === undefined) return;
      const target = canvasRef.current?.querySelector<HTMLButtonElement>(
        `[data-flow-marker-id="${CSS.escape(`${projectId}:${next}`)}"]`,
      );
      target?.focus({ preventScroll: true });
    },
    [projectId, snapshot],
  );

  const nodes = useMemo(
    () =>
      buildHistoryFlow(
        snapshot,
        { projectId, selectedPoint, highlightedSession, onSelectPoint },
        { onFocus: handleFocusNode, onNavigate: handleNavigate },
        revealedPoint,
      ),
    [
      snapshot,
      projectId,
      selectedPoint,
      highlightedSession,
      onSelectPoint,
      handleFocusNode,
      handleNavigate,
      revealedPoint,
    ],
  );
  const edges = snapshot?.edges ?? [];

  useLayoutEffect(() => {
    if (snapshot === null || instance === null) return;
    const previous = previousSnapshotRef.current;
    if (previous !== snapshot) {
      if (previous !== null && previous.projectId === projectId) {
        const active = document.activeElement;
        const focusedId =
          active instanceof HTMLButtonElement && canvasRef.current?.contains(active)
            ? (active.dataset.flowMarkerId ?? null)
            : null;
        const viewport = preserveHistoryViewport(
          previous,
          snapshot,
          instance.getViewport(),
          canvasRef.current?.clientHeight ?? 600,
          focusedId,
        );
        void instance.setViewport(viewport, { duration: 0 });
      } else {
        void instance.setViewport(HISTORY_DEFAULT_VIEWPORT, { duration: 0 });
      }
      previousSnapshotRef.current = snapshot;
    }
    const focused = focusedRef.current;
    if (focused !== null && !focused.isConnected && document.activeElement === document.body) {
      const ref =
        focused.dataset.graphPoint ?? focused.dataset.openEnd ?? focused.dataset.boundaryPoint;
      const replacement =
        ref === undefined
          ? null
          : canvasRef.current?.querySelector<HTMLButtonElement>(
              `[data-graph-point="${CSS.escape(ref)}"]`,
            );
      restoringFocusRef.current = true;
      (replacement ?? headingRef.current)?.focus({ preventScroll: true });
      restoringFocusRef.current = false;
    }
  }, [snapshot, instance, projectId]);

  /**
   * Возвращает исходные положение и масштаб после любой панорамы или перехода к ветке.
   */
  const handleResetView = (): void => {
    setRevealedPoint(null);
    void instance?.setViewport(HISTORY_DEFAULT_VIEWPORT, { duration: 0 });
  };

  const hasReadError = isDefined(query.error);
  const hasLayoutError = layout.error !== null;
  const isUnsupported = query.isSupported === false;
  const isEmpty =
    snapshot !== null &&
    isEmptyArray(snapshot.graph.items) &&
    isEmptyArray(snapshot.graph.openEnds);
  const isFirstPending = snapshot === null && (query.isLoading || layout.isPending);
  const countLabel =
    snapshot === null
      ? "История проекта"
      : `${snapshot.graph.items.length} из ${snapshot.graph.total} точек проекта`;
  const statusLabel = layout.isPending ? "Раскладка ELK…" : query.isRefreshing ? "Обновляем…" : "";
  const isCameraDisabled = snapshot === null || instance === null;
  const isMoreDisabled = query.isRefreshing || layout.isPending;
  const version = snapshot?.graph.version;
  return (
    <section
      {...rootAttrs}
      className={clsx(styles.root, className)}
      aria-label="Граф истории всего проекта"
      data-layout-engine="elk"
      data-layout-version={version}
      onFocusCapture={(event) => {
        if (
          event.target instanceof HTMLButtonElement &&
          event.target.dataset.flowMarkerId !== undefined
        ) {
          focusedRef.current = event.target;
        }
      }}
    >
      <h2 ref={headingRef} tabIndex={-1} className={styles.visuallyHidden}>
        Граф истории всего проекта
      </h2>
      <div className={styles.toolbar}>
        <div className={styles.toolbarSummary}>
          <span className={styles.count}>{countLabel}</span>
          <span className={styles.legend}>
            <Circle size={16} aria-hidden="true" />
            <span className={styles.solidSample} aria-hidden="true" /> Основной агент{" "}
            <Circle size={16} aria-hidden="true" />
            <span className={styles.dashedSample} aria-hidden="true" /> Субагент
          </span>
        </div>
        <div className={styles.controls}>
          <span role="status" className={styles.update}>
            {statusLabel}
          </span>
          <Button
            variant="subtle"
            size="compact-sm"
            aria-label="Сбросить вид графа"
            title="Сбросить вид графа: начальная позиция и масштаб 100%"
            disabled={isCameraDisabled}
            onClick={handleResetView}
          >
            <RotateCcw size={16} aria-hidden="true" />
          </Button>
          <Button
            variant="subtle"
            size="compact-sm"
            aria-label="Уменьшить масштаб графа"
            disabled={isCameraDisabled}
            onClick={() => void instance?.zoomOut({ duration: 0 })}
          >
            <Minus size={16} aria-hidden="true" />
          </Button>
          <span className={styles.zoom}>{zoomPercent}%</span>
          <Button
            variant="subtle"
            size="compact-sm"
            aria-label="Увеличить масштаб графа"
            disabled={isCameraDisabled}
            onClick={() => void instance?.zoomIn({ duration: 0 })}
          >
            <Plus size={16} aria-hidden="true" />
          </Button>
          <Button
            variant="subtle"
            size="compact-sm"
            aria-label="Перечитать граф"
            onClick={query.refresh}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>
      <UnfinishedSessions items={unfinishedItems} onRevealPoint={handleRevealPoint} />
      {hasReadError && (
        <div role="alert" className={styles.notice}>
          <span>{query.error?.message}</span>
          <Button variant="default" size="xs" onClick={query.refresh}>
            Повторить чтение
          </Button>
        </div>
      )}
      {hasLayoutError && (
        <div role="alert" className={styles.notice}>
          <span>{layout.error}</span>
          <Button variant="default" size="xs" onClick={layout.retry}>
            Повторить раскладку
          </Button>
        </div>
      )}
      {isUnsupported && (
        <p className={styles.notice}>
          Server не поддерживает граф истории ({WORK_HISTORY_GRAPH_CAPABILITY}). Обновите Server и
          Web вместе.
        </p>
      )}
      {isFirstPending && (
        <p role="status" className={styles.notice}>
          Загружаем и располагаем граф проекта…
        </p>
      )}
      {isEmpty && (
        <p className={styles.notice}>
          История проекта пока пуста. Здесь появятся сохранённые ветки и точки работы.
        </p>
      )}
      <div
        ref={canvasRef}
        className={styles.viewport}
        role="region"
        aria-label="Холст истории: панорама, масштаб и точки"
      >
        <ReactFlow<HistoryFlowNode, HistoryFlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onInit={setInstance}
          onMove={(_event, viewport) => setZoomPercent(Math.round(viewport.zoom * 100))}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          edgesReconnectable={false}
          elementsSelectable={false}
          connectOnClick={false}
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          panOnScroll
          panOnScrollMode={PanOnScrollMode.Free}
          panOnDrag
          zoomOnScroll={false}
          zoomOnPinch
          minZoom={0.45}
          maxZoom={1.6}
          autoPanOnNodeFocus={false}
          colorMode={colorScheme}
          ariaLabelConfig={HISTORY_ARIA_LABELS}
          defaultViewport={HISTORY_DEFAULT_VIEWPORT}
        />
      </div>
      <div className={styles.footer}>
        <span>Наведение — описание · Enter / нажатие — материал · колёсико — панорама</span>
        {query.hasMore && (
          <Button variant="default" size="xs" disabled={isMoreDisabled} onClick={query.loadMore}>
            Более ранние точки
          </Button>
        )}
      </div>
    </section>
  );
};
