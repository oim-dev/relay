import type { ElkNode } from "elkjs/lib/elk-api";
import type { XYPosition } from "@xyflow/react";
import type {
  WorkGraph,
  WorkGraphBranch,
  WorkGraphPoint,
  WorkGraphRun,
  WorkGraphBoundary,
} from "domains/work-history";
import type { HistoryFlowEdge, HistoryPort } from "./history-flow.type";

/** Семантика визуального элемента без заранее назначенных координат. */
export type HistoryMarker =
  | {
      kind: "point";
      point: WorkGraphPoint;
      branch: WorkGraphBranch;
      run: WorkGraphRun | null;
      color: string;
      /** Последняя сохранённая точка незавершённой ветки. */
      isOpenEnd: boolean;
      /** Передана через openEnds за пределами загруженных страниц. */
      isOutsidePage: boolean;
    }
  | { kind: "boundary"; boundary: WorkGraphBoundary; branch: WorkGraphBranch; color: string }
  | { kind: "date"; at: string; dayLabel: string; timeLabel: string }
  | { kind: "anchor" };

/** Семантика рисуемого ребра; служебные constraints сюда не попадают. */
export type HistoryEdgeMetadata = {
  /** Вид отображаемой связи. */
  kind: NonNullable<HistoryFlowEdge["data"]>["kind"];
  /** Цвет по владельцу, независимо от колонки. */
  color: string;
  /** Непрочитанный конец явно отмечен контрактом. */
  isBoundary: boolean;
  /** Ветка субагента; её линии отличаются пунктиром. */
  isWorker: boolean;
  /** Незавершённая работа должна читаться поверх закрытой в местах пересечения. */
  isUnfinished: boolean;
};

/** Вход движка и семантические таблицы для чтения результата. */
export type HistoryElkPlan = {
  /** Настоящая задача раскладки ELK. */
  graph: ElkNode;
  /** Только рисуемые ноды; остальные остаются техническими constraints. */
  markers: Map<string, HistoryMarker>;
  /** Рисуемые рёбра с реальными endpoint/port IDs. */
  edges: Map<string, HistoryEdgeMetadata>;
  /** Порядок доступных настоящих точек для клавиатуры. */
  pointOrder: string[];
  /** Допустимая высота краткого split/join в выбранной модели ELK. */
  maxConnectorSpan: number;
};

/** Нода в координатах, рассчитанных ELK. */
export type HistoryPlacedNode = {
  /** Геометрический ID, включая технические якоря. */
  id: string;
  /** Позиция ELK с единым преобразованием вложенных систем координат. */
  position: XYPosition;
  /** Размер ELK, не bbox длинной подписи. */
  width: number;
  /** Высота ELK. */
  height: number;
  /** Согласованные невидимые порты. */
  ports: HistoryPort[];
  /** Предметная либо декоративная роль. */
  marker: HistoryMarker;
};

/** Результат одной согласованной раскладки, вместе с показанным серверным срезом. */
export type HistoryElkSnapshot = {
  /** Область поздних ответов и камеры. */
  projectId: string;
  /** Тот же срез, что использован при layout; счётчики не берутся из следующего pending-среза. */
  graph: WorkGraph;
  /** Реальные позиции ELK. */
  nodes: Map<string, HistoryPlacedNode>;
  /** Готовые маршруты из sections. */
  edges: HistoryFlowEdge[];
  /** Клавиатурная хронология только реальных точек. */
  pointOrder: string[];
  /** Границы раскладки для камеры. */
  width: number;
  /** Полная высота раскладки. */
  height: number;
};
