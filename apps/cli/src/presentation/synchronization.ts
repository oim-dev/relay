import type { SynchronizationStatus } from "@relay/contracts/synchronization";
import { cardText } from "./common.js";
import type { TextOptions } from "./theme.js";

const labels: Record<SynchronizationStatus["status"], string> = {
  local: "Локальная база, origin не настроен",
  synced: "Синхронизировано",
  pending: "Ожидается отправка",
  syncing: "Выполняется в фоне",
  offline: "Origin недоступен или отправка не удалась",
  conflict: "Конфликт доставки; локальная работа доступна",
  unknown: "Удалённое состояние ещё не проверено",
};

export function synchronizationText(status: SynchronizationStatus, options: TextOptions): string {
  return cardText(
    {
      title: `Синхронизация: ${labels[status.status]}`,
      fields: [
        ["Origin", status.origin ?? "не настроен", "opaque"],
        [
          "Коммиты без подтверждения",
          status.queuedCommits ?? "число неизвестно до проверки origin",
        ],
        ["Изменения вне коммитов", status.uncommittedChanges ? "есть, сохранены в базе" : "нет"],
        ["Последняя синхронизация", status.lastSuccessAt ?? "не подтверждена"],
        ["Следующая попытка", status.nextAttemptAt ?? "по запросу"],
        ["Конфликт", status.conflictId],
        ["Ошибка", status.error?.message],
      ],
    },
    options,
  );
}

export function synchronizationWarning(status: SynchronizationStatus): string | undefined {
  if (!status.origin || (!status.error && status.status !== "conflict")) return;
  const count =
    status.queuedCommits === null
      ? "число ожидающих коммитов пока неизвестно"
      : `без подтверждения синхронизации: ${status.queuedCommits} коммитов`;
  const reason =
    status.status === "conflict" ? labels.conflict : "Последняя попытка синхронизации не удалась";
  return `Данные сохранены локально. ${reason}; ${count}${status.uncommittedChanges ? "; есть изменения вне коммитов" : ""}.`;
}
