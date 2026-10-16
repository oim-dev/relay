import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Параметры визуальной области. */
export type MarkdownFieldParams = {
  /** Название поля. */
  label: string;
  /** Начальное значение неконтролируемого редактора. */
  defaultValue?: string;
  /** Изменение строки для владельца формы. */
  onChange?: (value: string) => void;
  /** Потеря фокуса для проверки поля. */
  onBlur?: () => void;
  /** Состояние ошибки формы. */
  error?: ReactNode;
  /** Подсказка по содержанию. */
  placeholder?: string;
  /** Обязательное поле: звёздочка у подписи и aria-required у редактора, как required у Mantine Input. */
  required?: boolean;
  /** Звёздочка без aria-required; по умолчанию совпадает с required, как у Mantine Input. */
  withAsterisk?: boolean;
  /** Блокировка на время сохранения. */
  disabled?: boolean;
  /**
   * Путь поля из getInputProps Mantine form. Ставится на редактируемую область,
   * поэтому form.getInputNode(path)?.focus() переводит фокус в редактор.
   */
  "data-path"?: string;
  /** Минимальная высота в строках; по умолчанию четыре. */
  minRows?: number;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<
  ComponentPropsWithoutRef<"div">,
  "children" | "defaultValue" | "onChange" | "onBlur"
>;
/** Свойства визуальной области. */
export type MarkdownFieldProps = RootAttrs & MarkdownFieldParams;
