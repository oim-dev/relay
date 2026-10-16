import type { WorkGraphPointDetail } from "domains/work-history";
import { getPointReadingGuide } from "./point-reading-guide";

/** Заполненный смысловой Markdown-раздел выбранной точки. */
export type PointMaterial = {
  /** Название, соответствующее виду события. */
  label: string;
  /** Полный исходный Markdown. */
  text: string;
};

/**
 * Выбирает полные материалы конкретного события, не выдавая lifecycle за checkpoint.
 */
export const getPointMaterials = (detail: WorkGraphPointDetail): PointMaterial[] => {
  const { point, session, checkpoint, run } = detail;
  const { materialLabel } = getPointReadingGuide(detail);
  if (checkpoint !== null)
    return [
      { label: materialLabel, text: checkpoint.body },
      { label: "Сделано", text: checkpoint.done },
      { label: "Остаток и блокеры", text: checkpoint.remaining },
      { label: "Следующий шаг", text: checkpoint.nextStep },
      { label: "Проверки", text: checkpoint.checks },
    ].filter((field) => field.text.trim() !== "");
  if (point.kind === "session-created")
    return session.description.trim() === ""
      ? []
      : [{ label: materialLabel, text: session.description }];
  if (point.kind === "session-closed")
    return session.result.trim() === "" ? [] : [{ label: materialLabel, text: session.result }];
  const text = point.kind === "run-started" ? (run?.reason ?? "") : (run?.endSummary ?? "");
  return text.trim() === "" ? [] : [{ label: materialLabel, text }];
};
