/** Подписчики локальных изменений материалов по ID проекта. */
const listeners = new Map<string, Set<() => void>>();

/**
 * Подписывает чтение материалов проекта на изменения, сделанные из этой вкладки.
 * SSE сообщает об изменениях других клиентов; локальный сигнал не ждёт потока и работает без него.
 */
export const subscribeMaterialsChanged = (
  projectId: string,
  listener: () => void,
): (() => void) => {
  const projectListeners = listeners.get(projectId) ?? new Set<() => void>();
  projectListeners.add(listener);
  listeners.set(projectId, projectListeners);
  return () => {
    projectListeners.delete(listener);
    if (projectListeners.size === 0) listeners.delete(projectId);
  };
};

/** Сообщает всем чтениям материалов проекта, что подтверждённые данные изменились. */
export const publishMaterialsChanged = (projectId: string): void => {
  listeners.get(projectId)?.forEach((listener) => listener());
};
