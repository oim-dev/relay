import type { ComponentPropsWithoutRef } from "react";
import type { DocumentSection, MaterialBulkOperation } from "domains/documents";

/** Параметры панели массовых действий. */
export type BulkActionsParams = {
  /** Проект для подсказок тегов. */
  projectId: string;
  /** Число выбранных материалов. */
  count: number;
  /** Выбор больше допустимого для одного действия. */
  isOverLimit: boolean;
  /** Идёт запись. */
  isRunning: boolean;
  /** Разделы библиотеки. */
  sections: DocumentSection[];
  /** Теги выбранных материалов: варианты для снятия. */
  selectedTags: string[];
  /** Выполнение одного действия с описанием для отчёта. */
  onRun: (operation: MaterialBulkOperation, action: string) => void;
  /** Снятие выбора. */
  onClear: () => void;
};
/** Атрибуты панели. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства панели массовых действий. */
export type BulkActionsProps = RootAttrs & BulkActionsParams;
