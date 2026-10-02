import { useState } from "react";
import { DocumentAccessError, useMaterialMutations } from "domains/documents";
import type { MaterialBulkItem, MaterialBulkOperation } from "domains/documents";
import type { BulkOutcome, BulkRemainder, SelectedMaterial } from "../types/bulk.type";

/** Причина неприменённого элемента для человека. */
const REMAINDER_REASONS: Record<BulkRemainder["status"], string> = {
  conflict: "изменён после загрузки списка",
  not_found: "не найден: удалён или перенесён",
  invalid: "отклонён правилом данных",
  error: "не записан из-за ошибки",
};

/** Проверяет, что элемент не применён. */
const isRemainder = (
  item: MaterialBulkItem,
): item is MaterialBulkItem & { status: BulkRemainder["status"] } =>
  item.status !== "applied" && item.status !== "unchanged";

/**
 * Хранит множественный выбор текущей области каталога и выполняет массовые действия.
 * Каждое действие — один запрос без автоповторов. После частичного отказа в выборе остаются
 * только неприменённые материалы, которые можно повторить осознанно; не найденные снимаются.
 * Ревизия берётся на момент выбора: изменение, сделанное после него, даёт конфликт, а не
 * молчаливую перезапись; для повтора используется актуальная ревизия из ответа сервера.
 */
export const useBulkSelection = (projectId: string, scopeKey: string) => {
  const mutations = useMaterialMutations(projectId);
  const [state, setState] = useState<{ scopeKey: string; items: Map<string, SelectedMaterial> }>({
    scopeKey,
    items: new Map(),
  });
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);
  const [isRunning, setRunning] = useState(false);
  const [defect, setDefect] = useState<Error>();
  if (defect !== undefined) throw defect;
  const selected = state.scopeKey === scopeKey ? state.items : new Map<string, SelectedMaterial>();
  /** Меняет выбор, начиная новый набор при смене области. */
  const update = (change: (items: Map<string, SelectedMaterial>) => void): void => {
    setState((current) => {
      const items = new Map(current.scopeKey === scopeKey ? current.items : []);
      change(items);
      return { scopeKey, items };
    });
  };
  const toggle = (materials: SelectedMaterial[], isSelected: boolean): void =>
    update((items) =>
      materials.forEach((material) => {
        if (isSelected) items.set(material.id, material);
        else items.delete(material.id);
      }),
    );
  const clear = (): void => update((items) => items.clear());
  /** Выполняет одно действие для выбранных материалов и сообщает фактический результат. */
  const run = async (operation: MaterialBulkOperation, action: string): Promise<void> => {
    const chosen = [...selected.values()];
    setRunning(true);
    try {
      const result = await mutations.bulkChange(chosen, operation, crypto.randomUUID());
      const byId = new Map(chosen.map((material) => [material.id, material]));
      const remainder = result.items.filter(isRemainder).map((item) => ({
        id: item.target?.id ?? item.ref,
        title: byId.get(item.ref)?.title ?? item.key ?? item.ref,
        status: item.status,
        reason: [REMAINDER_REASONS[item.status], item.error?.message].filter(Boolean).join(": "),
      }));
      setOutcome({
        action,
        total: chosen.length,
        applied: result.applied,
        unchanged: result.items.filter((item) => item.status === "unchanged").length,
        remainder,
        requestError: null,
      });
      const retry = new Map<string, SelectedMaterial>();
      result.items.filter(isRemainder).forEach((item) => {
        const material = byId.get(item.ref);
        if (material === undefined || item.status === "not_found") return;
        retry.set(material.id, { ...material, revision: item.revision ?? material.revision });
      });
      setState({ scopeKey, items: retry });
    } catch (failure) {
      if (failure instanceof DocumentAccessError)
        setOutcome({
          action,
          total: chosen.length,
          applied: 0,
          unchanged: 0,
          remainder: [],
          requestError: failure.message,
        });
      else
        setDefect(failure instanceof Error ? failure : new Error("Массовое действие не выполнено"));
    } finally {
      setRunning(false);
    }
  };
  return {
    selected,
    toggle,
    clear,
    run,
    isRunning,
    outcome,
    dismissOutcome: () => setOutcome(null),
  };
};
