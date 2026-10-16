import { useEffect, useRef, useState } from "react";
import ELK from "elkjs/lib/elk-api";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import type { WorkGraph } from "domains/work-history";
import { readHistoryElk } from "../helpers/read-history-elk";
import type { HistoryElkPlan, HistoryElkSnapshot } from "../types/history-elk.type";

/** Результат асинхронной раскладки со старым согласованным срезом на время обновления. */
export type HistoryElkState = {
  /** Только полностью рассчитанный срез текущего проекта. */
  snapshot: HistoryElkSnapshot | null;
  /** Новая раскладка ещё не готова, прежняя остаётся видимой. */
  isPending: boolean;
  /** Локализованная причина отказа движка. */
  error: string | null;
  /** Повторить расчёт, не заменяя его ручной геометрией. */
  retry: () => void;
};

/**
 * Запускает ELK в собственном Worker. Смена данных/проекта отменяет предыдущего владельца;
 * поздний результат не меняет ни видимый граф, ни его счётчики. Worker освобождается всегда.
 */
export const useHistoryElk = (
  projectId: string,
  graph: WorkGraph | null,
  buildPlan: (graph: WorkGraph) => HistoryElkPlan,
): HistoryElkState => {
  const generation = useRef(0);
  const [snapshot, setSnapshot] = useState<HistoryElkSnapshot | null>(null);
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (graph === null) return;
    const token = ++generation.current;
    let isActive = true;
    let elk: InstanceType<typeof ELK> | undefined;
    setPending(true);
    setError(null);
    /**
     * Сохраняет данные и геометрию атомарно только после успешного ответа движка.
     */
    const calculate = async (): Promise<void> => {
      try {
        const plan = buildPlan(graph);
        elk = new ELK({ workerFactory: () => new Worker(elkWorkerUrl) });
        const result = await elk.layout(plan.graph);
        if (!isActive || token !== generation.current) return;
        const next = readHistoryElk(result, plan, graph, projectId);
        setSnapshot(next);
      } catch (failure) {
        if (isActive && token === generation.current) {
          const details = failure instanceof Error ? failure.message : "неизвестная ошибка движка";
          setError(`Не удалось рассчитать граф в ELK. ${details}`);
        }
      } finally {
        elk?.terminateWorker();
        if (isActive && token === generation.current) setPending(false);
      }
    };
    void calculate();
    return () => {
      isActive = false;
      elk?.terminateWorker();
    };
  }, [projectId, graph, buildPlan, attempt]);
  const visibleSnapshot = snapshot?.projectId === projectId ? snapshot : null;
  const isAwaitingSnapshot = graph !== null && visibleSnapshot?.graph !== graph && error === null;
  return {
    snapshot: visibleSnapshot,
    isPending: isPending || isAwaitingSnapshot,
    error,
    retry: () => setAttempt((value) => value + 1),
  };
};
