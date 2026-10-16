import type { HistoryPort } from "../../../types/history-flow.type";

/** Параметры визуальной области. */
export type HistoryHandlesParams = {
  /** ID React Flow ноды. */
  nodeId: string;
  /** Реальные позиции портов из ELK. */
  ports: HistoryPort[];
};
/** Свойства визуальной области. */
export type HistoryHandlesProps = HistoryHandlesParams;
