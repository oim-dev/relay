import {
  AppWindow,
  Boxes,
  FileText,
  Folder,
  Kanban,
  Layers,
  ListTodo,
  Puzzle,
  Route,
  Flag,
  Rocket,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { EntityKind } from "@relay/contracts/entities";

/**
 * Обозначение вида сущности для каталога и контекста. Вид различается иконкой
 * и подписью; цвет не кодирует вид, поэтому оформление задаёт потребитель ролями темы.
 */
type EntityPresentation = {
  /** Русское название вида. */
  label: string;
  /** Принятая в проекте иконка. */
  icon: LucideIcon;
};

/** Единые обозначения основных видов сущностей. */
export const ENTITY_PRESENTATION = {
  project: { label: "Проект", icon: Folder },
  product: { label: "Продукт", icon: Boxes },
  feature: { label: "Фича", icon: Puzzle },
  scenario: { label: "Сценарий", icon: Route },
  application: { label: "Приложение", icon: AppWindow },
  implementation: { label: "Реализация", icon: Layers },
  document: { label: "Документ", icon: FileText },
  board: { label: "Доска", icon: Kanban },
  task: { label: "Задача", icon: ListTodo },
  "work-plan": { label: "План работ", icon: Flag },
  release: { label: "Релиз", icon: Rocket },
} satisfies Record<EntityKind, EntityPresentation>;

/**
 * Сохраняет техническое имя и нейтральное оформление расширенного вида.
 */
export const getEntityPresentation = (kind: string): EntityPresentation =>
  Object.entries(ENTITY_PRESENTATION).find(([key]) => key === kind)?.[1] ?? {
    label: kind,
    icon: Boxes,
  };
