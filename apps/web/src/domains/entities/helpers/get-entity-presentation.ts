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

/** Обозначение вида сущности для каталога и контекста. */
type EntityPresentation = {
  /** Русское название вида. */
  label: string;
  /** Принятая в проекте иконка. */
  icon: LucideIcon;
  /** Семантический цвет Mantine. */
  color: string;
};

/** Единые обозначения основных видов сущностей. */
export const ENTITY_PRESENTATION = {
  project: { label: "Проект", icon: Folder, color: "gray" },
  product: { label: "Продукт", icon: Boxes, color: "blue" },
  feature: { label: "Фича", icon: Puzzle, color: "violet" },
  scenario: { label: "Сценарий", icon: Route, color: "teal" },
  application: { label: "Приложение", icon: AppWindow, color: "blue" },
  implementation: { label: "Реализация", icon: Layers, color: "indigo" },
  document: { label: "Документ", icon: FileText, color: "orange" },
  board: { label: "Доска", icon: Kanban, color: "gray" },
  task: { label: "Задача", icon: ListTodo, color: "cyan" },
  "work-plan": { label: "План работ", icon: Flag, color: "blue" },
  release: { label: "Релиз", icon: Rocket, color: "teal" },
} satisfies Record<EntityKind, EntityPresentation>;

/**
 * Сохраняет техническое имя и нейтральное оформление расширенного вида.
 */
export const getEntityPresentation = (kind: string): EntityPresentation =>
  Object.entries(ENTITY_PRESENTATION).find(([key]) => key === kind)?.[1] ?? {
    label: kind,
    icon: Boxes,
    color: "gray",
  };
