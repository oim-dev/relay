import { z } from "zod";
import type { PlanFormValues } from "../types/plan-form-props.type";

const MARKDOWN = z.array(z.string()).transform((lines) => lines.join("\n"));
const DRAFT_SCHEMA = z.object({
  revision: z.number().int().nonnegative(),
  title: z.string(),
  summary: z.string(),
  goal: MARKDOWN,
});

/**
 * Восстанавливает незавершённый ввод только при известной схеме.
 */
export const readPlanDraft = (
  key: string,
  fallback: PlanFormValues,
): { values: PlanFormValues; error: string | null } => {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return { values: fallback, error: null };
    const content: unknown = JSON.parse(raw);
    const parsed = DRAFT_SCHEMA.safeParse(content);
    if (parsed.success && (parsed.data.revision === 0) === (fallback.revision === 0))
      return { values: parsed.data, error: null };
    return {
      values: fallback,
      error: "Черновик имеет неизвестный формат. Перед новым сохранением явно сбросьте его.",
    };
  } catch {
    return {
      values: fallback,
      error: "Не удалось прочитать черновик. Ввод в открытой форме остаётся доступным.",
    };
  }
};

/**
 * Сохраняет текстовые поля отдельно от подтверждённого плана.
 */
export const writePlanDraft = (key: string, values: PlanFormValues): string | null => {
  try {
    sessionStorage.setItem(
      key,
      JSON.stringify({
        ...values,
        goal: values.goal.split("\n"),
      }),
    );
    return null;
  } catch {
    return "Черновик не сохранён в браузере. Не закрывайте форму до сохранения плана.";
  }
};

/**
 * Удаляет только подтверждённый либо явно отклонённый черновик.
 */
export const clearPlanDraft = (key: string): void => {
  sessionStorage.removeItem(key);
};
