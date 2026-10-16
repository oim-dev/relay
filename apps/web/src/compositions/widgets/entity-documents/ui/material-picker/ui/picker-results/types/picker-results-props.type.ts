import type { ComponentPropsWithoutRef } from "react";
import type { AttachOutcome } from "../../../types/attach-outcome.type";

/** Параметры итога прикрепления. */
export type PickerResultsParams = {
  /** Исходы в порядке выбора. */
  outcomes: AttachOutcome[];
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children">;
/** Свойства итога прикрепления. */
export type PickerResultsProps = RootAttrs & PickerResultsParams;
