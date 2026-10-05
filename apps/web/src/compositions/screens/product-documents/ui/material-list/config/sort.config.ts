import type { MaterialSort } from "domains/documents";

/** Варианты порядка выдачи. */
export const SORT_OPTIONS: { value: MaterialSort; label: string }[] = [
  { value: "updated", label: "Сначала обновлённые" },
  { value: "title", label: "По названию" },
];
