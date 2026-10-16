import { useState } from "react";
import { notifications } from "@mantine/notifications";
import {
  DocumentAccessError,
  DocumentConflictError,
  DocumentOutcomeUnknownError,
  useMaterialMutations,
} from "domains/documents";
import type { MaterialPropertyChanges } from "domains/documents";

/** Материал, свойства которого меняет быстрое действие. */
type ActionTarget = {
  /** Постоянный ID. */
  id: string;
  /** Ревизия, прочитанная вместе со строкой каталога. */
  revision: number;
  /** Название для сообщения о результате. */
  title: string;
};

/** Отказ действия, показанный рядом с выдачей. */
export type MaterialActionNotice = {
  /** Конфликт ревизии, неизвестный исход или отказ записи. */
  tone: "warning" | "danger";
  /** Заголовок отказа. */
  title: string;
  /** Причина и следующий шаг. */
  message: string;
};

/** Сообщение об успешном изменении. */
const getSuccessMessage = (changes: MaterialPropertyChanges): string => {
  if (changes.pinned === true) return "Материал закреплён";
  if (changes.pinned === false) return "Материал откреплён";
  if (changes.documentStatus === "archived") return "Материал перенесён в архив";
  if (changes.documentStatus === "active") return "Материал возвращён из архива";
  return "Материал перемещён";
};

/**
 * Выполняет быстрые изменения свойств под прочитанной ревизией через записи домена,
 * которые сами перечитывают каталог, счётчики и карточки.
 * Конфликт и неизвестный исход не повторяются автоматически: решение остаётся за человеком.
 * Отсутствие ответа сервера не считается отказом — изменение могло сохраниться.
 */
export const useMaterialActions = (
  projectId: string,
): {
  busyIds: ReadonlySet<string>;
  notice: MaterialActionNotice | null;
  dismissNotice: () => void;
  change: (target: ActionTarget, changes: MaterialPropertyChanges) => Promise<void>;
} => {
  const mutations = useMaterialMutations(projectId);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<MaterialActionNotice | null>(null);
  const [defect, setDefect] = useState<Error>();
  if (defect !== undefined) throw defect;
  /** Отмечает запись материала, не блокируя остальные строки. */
  const setBusy = (id: string, isBusy: boolean): void => {
    setBusyIds((current) => {
      const next = new Set(current);
      if (isBusy) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const change = async (target: ActionTarget, changes: MaterialPropertyChanges): Promise<void> => {
    setBusy(target.id, true);
    setNotice(null);
    try {
      await mutations.changeProperties(target, changes, crypto.randomUUID());
      notifications.show({ message: `${getSuccessMessage(changes)}: «${target.title}»` });
    } catch (failure) {
      if (failure instanceof DocumentConflictError)
        setNotice({
          tone: "warning",
          title: "Материал уже изменён",
          message: `«${target.title}» изменился после загрузки списка, действие не выполнено. Проверьте актуальное состояние в списке и при необходимости повторите действие.`,
        });
      else if (failure instanceof DocumentOutcomeUnknownError)
        setNotice({
          tone: "warning",
          title: "Результат действия неизвестен",
          message: `Ответ сервера не получен или не прочитан: изменение «${target.title}» могло сохраниться. Проверьте текущее состояние перед повтором.`,
        });
      else if (failure instanceof DocumentAccessError)
        setNotice({
          tone: "danger",
          title: "Не удалось изменить материал",
          message: failure.message,
        });
      else
        setDefect(failure instanceof Error ? failure : new Error("Не удалось изменить материал"));
    } finally {
      setBusy(target.id, false);
    }
  };
  return { busyIds, notice, dismissNotice: () => setNotice(null), change };
};
