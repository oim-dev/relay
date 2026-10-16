import type { ComponentPropsWithoutRef } from "react";

/** Состояние потока изменений проекта. */
export type ConnectionState =
  "connecting" | "connected" | "reconnecting" | "disconnected" | "storage-error";

/** Параметры индикатора подключения. */
export type ConnectionStatusParams = {
  /** Текущее состояние потока изменений. */
  state: ConnectionState;
  /** Диагностика отказа хранилища от сервера. */
  message?: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children" | "role">;
/** Свойства индикатора подключения. */
export type ConnectionStatusProps = RootAttrs & ConnectionStatusParams;
