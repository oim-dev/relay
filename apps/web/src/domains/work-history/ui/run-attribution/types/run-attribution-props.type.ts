import type { ComponentPropsWithoutRef } from "react";
import type { AgentRunSummary } from "@relay/contracts/work-history";

/** Параметры визуальной области. */
export type RunAttributionParams = {
  /** Сохранённое участие, а не состояние клиента сейчас. */
  run: AgentRunSummary | null;
  /** Краткая атрибуция в обзоре ветки, без полей подключения. */
  compact?: boolean;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"dl">, "children">;
/** Свойства визуальной области. */
export type RunAttributionProps = RootAttrs & RunAttributionParams;
