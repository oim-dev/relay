import {
  AppWindow,
  ChartNoAxesCombined,
  FileText,
  Files,
  Flag,
  Rocket,
  Sparkles,
} from "lucide-react";

/** Длинное название проекта: выбор сокращает его, полное — в подсказке и списке. */
export const SHELL_PROJECT_NAME = "Платформа поддержки клиентов и внешних интеграций";

/** Проекты выбора: недоступный проект — отключённый пункт списка. */
export const SHELL_PROJECTS = [
  { value: "support", label: SHELL_PROJECT_NAME },
  { value: "relay", label: "Relay" },
  { value: "archive", label: "Архив поддержки (недоступен)", disabled: true },
];

/** Пункты верхнего уровня до группы «Продукт». */
export const SHELL_TOP_ITEMS = [{ id: "overview", label: "Обзор", Icon: ChartNoAxesCombined }];

/** Вложенные пункты группы «Продукт». */
export const SHELL_PRODUCT_ITEMS = [
  { id: "passport", label: "Паспорт", Icon: FileText },
  { id: "features", label: "Возможности", Icon: Sparkles },
  { id: "applications", label: "Приложения", Icon: AppWindow },
];

/** Рабочие разделы и материалы после группы; второй блок начинается отступом. */
export const SHELL_WORK_ITEMS = [
  { id: "plans", label: "Планы", Icon: Flag, isGroupStart: false },
  { id: "releases", label: "Релизы", Icon: Rocket, isGroupStart: false },
  { id: "documents", label: "Библиотека знаний", Icon: Files, isGroupStart: true },
];

/** Строки панели «Требует внимания». */
export const SHELL_ATTENTION = [
  {
    id: "1",
    code: "REL-12",
    title: "Релиз 2.4 ждёт проверки заметок к выпуску",
    status: "На проверке",
  },
  {
    id: "2",
    code: "TSK-87",
    title: "Миграция каталога материалов заблокирована",
    status: "Блокер",
  },
];
