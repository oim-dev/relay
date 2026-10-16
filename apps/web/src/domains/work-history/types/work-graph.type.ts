import type { WorkHistoryGraphPage } from "@relay/contracts/work-history-graph";

export type {
  WorkHistoryGraphPoint as WorkGraphPoint,
  WorkHistoryGraphBranch as WorkGraphBranch,
  WorkHistoryGraphEdge as WorkGraphEdge,
  WorkHistoryGraphBoundaryNode as WorkGraphBoundary,
  WorkHistoryGraphPointDetail as WorkGraphPointDetail,
} from "@relay/contracts/work-history-graph";
export type { AgentRunSummary as WorkGraphRun } from "@relay/contracts/work-history";

/** Согласованная загруженная часть графа, а не полный снимок всех работ. */
export type WorkGraph = Omit<WorkHistoryGraphPage, "scopeRootId" | "nextOffset">;

/** Чтение графа всего проекта и явное продолжение более ранними точками. */
export type WorkGraphState = {
  /** Согласованные компактные страницы; null до первого чтения. */
  graph: WorkGraph | null;
  /** Сервер явно объявляет новый графовый контракт. */
  isSupported: boolean | undefined;
  /** Выполняется первое чтение. */
  isLoading: boolean;
  /** Выполняется чтение или обновление уже показанного. */
  isRefreshing: boolean;
  /** Есть более ранняя непрочитанная страница. */
  hasMore: boolean;
  /** Отказ не удаляет ранее показанный граф. */
  error: Error | undefined;
  /** Перечитать запрошенный объём от новой первой страницы. */
  refresh: () => void;
  /** Явно открыть следующую порцию. */
  loadMore: () => void;
};
