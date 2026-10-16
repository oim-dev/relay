import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Визуальный тон состояния; предметный смысл задаёт владелец статуса. */
export type StatusBadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

/** Параметры бейджа состояния. */
export type StatusBadgeParams = {
  /** Визуальный тон. */
  tone?: StatusBadgeTone;
  /** Человекочитаемая подпись; может включать скрытый для зрения префикс. */
  children: ReactNode;
  /** Декоративная иконка перед подписью; смысл передаёт подпись. */
  icon?: ReactNode;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"span">, "children">;
/** Свойства бейджа состояния. */
export type StatusBadgeProps = RootAttrs & StatusBadgeParams;
