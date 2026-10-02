import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Параметры сообщения над выдачей. */
export type LibraryNoticeParams = {
  /** Предупреждение о конфликте или устаревших данных либо отказ. */
  tone: "warning" | "danger";
  /** Короткий заголовок. */
  title: string;
  /** Причина и следующий шаг. */
  message: string;
  /** Действие восстановления. */
  action?: ReactNode;
  /** Скрытие прочитанного сообщения. */
  onDismiss?: () => void;
};
/** Атрибуты сообщения. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children" | "title">;
/** Свойства сообщения над выдачей. */
export type LibraryNoticeProps = RootAttrs & LibraryNoticeParams;
