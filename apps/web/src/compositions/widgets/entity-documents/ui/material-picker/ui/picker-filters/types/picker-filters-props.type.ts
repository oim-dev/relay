import type { ComponentPropsWithoutRef } from "react";

/** Вариант фильтра со счётчиком сервера. */
export type PickerFilterOption = {
  /** Значение; пустая строка — без условия. */
  value: string;
  /** Подпись со счётчиком. */
  label: string;
};
/** Параметры поиска и фильтров выборщика. */
export type PickerFiltersParams = {
  /** Строка поиска. */
  query: string;
  /** Раздел: пусто — все, none — без раздела, иначе ID. */
  section: string;
  /** Тип материала или пусто. */
  kind: string;
  /** Формат или пусто. */
  format: string;
  /** Варианты разделов. */
  sectionOptions: PickerFilterOption[];
  /** Варианты типов. */
  kindOptions: PickerFilterOption[];
  /** Варианты форматов. */
  formatOptions: PickerFilterOption[];
  /** Меняет условие по имени. */
  onChange: (name: "query" | "section" | "kind" | "format", value: string) => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children" | "onChange">;
/** Свойства поиска и фильтров выборщика. */
export type PickerFiltersProps = RootAttrs & PickerFiltersParams;
