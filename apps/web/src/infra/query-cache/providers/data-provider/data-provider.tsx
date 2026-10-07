import { SWRConfig } from "swr";
import { isStorageFailure } from "infra/tasks-api";
import type { DataProviderProps } from "./types/data-provider-props.type";

/**
 * Задаёт политику общего кеша чтения REST.
 *
 * Используется для:
 *  - дедупликации запросов и ограниченного восстановления после сетевой ошибки
 *  - отказа от автоматического повтора, когда хранилище проекта требует обслуживания
 */
export const DataProvider = (props: DataProviderProps) => {
  return (
    <SWRConfig
      value={{
        dedupingInterval: 500,
        errorRetryCount: 2,
        errorRetryInterval: 3000,
        shouldRetryOnError: (error: Error) => !isStorageFailure(error),
        revalidateOnFocus: true,
      }}
    >
      {props.children}
    </SWRConfig>
  );
};
