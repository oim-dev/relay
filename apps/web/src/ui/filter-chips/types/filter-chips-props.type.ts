import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Вариант фильтра. */
export type FilterChipsOption<Value extends string> = {
  /** Значение, передаваемое в onChange. */
  value: Value;
  /** Видимая подпись. */
  label: ReactNode;
  /** Число записей варианта; ноль показывается, отсутствие значения скрывает число. */
  count?: ReactNode;
};

/** Параметры однозначного фильтра-переключателя. */
export type FilterChipsParams<Value extends string> = {
  /** Доступное имя группы: что фильтруется. */
  label: string;
  /** Варианты в порядке показа. */
  options: FilterChipsOption<Value>[];
  /** Выбранное значение. */
  value: Value;
  /** Выбор другого варианта. */
  onChange: (value: Value) => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children" | "onChange" | "role">;
/** Свойства фильтров-переключателей. */
export type FilterChipsProps<Value extends string> = RootAttrs & FilterChipsParams<Value>;
