import type { WorkGraphPoint, WorkGraphBranch, WorkGraphRun } from "../types/work-graph.type";
import { WORK_CHECKPOINT_LABELS } from "./work-labels";

/** Смысловой маркер точки, не новый вид предметного события. */
export type WorkPointPresentation = {
  /** Короткая подпись сохранённого действия. */
  label: string;
  /** Значок действия для графа и модального окна. */
  marker: "checkpoint" | "start" | "finish" | "pause" | "handoff" | "cancel" | "run";
};

/**
 * Представляет только сохранённый вид и исход участия; никакой эвристики online или сбоя агента.
 */
export const getWorkPointPresentation = (
  point: WorkGraphPoint,
  run: WorkGraphRun | null,
  branch: Pick<WorkGraphBranch, "status" | "parentSessionId">,
): WorkPointPresentation => {
  if (point.kind === "checkpoint")
    return { label: WORK_CHECKPOINT_LABELS[point.checkpointKind], marker: "checkpoint" };
  if (point.kind === "session-created")
    return {
      label: branch.parentSessionId === null ? "Начало работы" : "Ответвление субагента",
      marker: "start",
    };
  if (point.kind === "session-closed")
    return branch.status === "cancelled"
      ? { label: "Ветка отменена", marker: "cancel" }
      : { label: "Ветка завершена", marker: "finish" };
  if (point.kind === "run-started")
    return {
      label: point.predecessorRunId === null ? "Подключение агента" : "Продолжение другим участием",
      marker: point.predecessorRunId === null ? "run" : "handoff",
    };
  if (run?.endReason === "paused") return { label: "Пауза", marker: "pause" };
  if (run?.endReason === "transferred") return { label: "Передача участия", marker: "handoff" };
  if (run?.endReason === "cancelled") return { label: "Участие отменено", marker: "cancel" };
  return { label: "Участие окончено", marker: "finish" };
};
