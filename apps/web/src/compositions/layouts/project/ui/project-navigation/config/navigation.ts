import {
  AppWindow,
  FileText,
  Files,
  Flag,
  History,
  Rocket,
  Network,
  Server,
  Sparkles,
} from "lucide-react";

/** Подразделы продукта в порядке знакомства с ним. */
export const PRODUCT_NAVIGATION = [
  { path: "passport", label: "Паспорт", Icon: FileText },
  { path: "features", label: "Возможности", Icon: Sparkles },
  { path: "applications", label: "Приложения", Icon: AppWindow },
];

/** Рабочие разделы проекта после продуктового контекста. */
export const PROJECT_NAVIGATION = [
  { path: "plans", label: "Планы", Icon: Flag },
  { path: "releases", label: "Релизы", Icon: Rocket },
];

/** Общие материалы и сопровождение проекта после разделителя. */
export const PROJECT_RESOURCES_NAVIGATION = [
  { path: "documents", label: "Библиотека знаний", Icon: Files },
  { path: "infrastructure", label: "Инфраструктура", Icon: Server },
  { path: "relations", label: "Связи проекта", Icon: Network },
  { path: "history", label: "История", Icon: History },
];
