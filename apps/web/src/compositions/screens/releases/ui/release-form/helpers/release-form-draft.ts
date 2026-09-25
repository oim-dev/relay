import { z } from "zod";
import type { ReleaseFormValues } from "../types/release-form-props.type";

const MARKDOWN = z.array(z.string()).transform((lines) => lines.join("\n"));
const DRAFT_SCHEMA = z.object({
  revision: z.number().int().nonnegative(),
  title: z.string(),
  version: z.string(),
  summary: z.string(),
  description: MARKDOWN,
  plannedFor: z.string(),
  status: z.enum(["planned", "released", "cancelled"]),
  planIds: z.array(z.string()),
});

/** Результат восстановления черновика. */
type DraftResult = {
  /** Восстановленный ввод. */
  values: ReleaseFormValues;
  /** Причина отказа. */
  error: string | null;
};

/**
 * Восстанавливает серверный черновик с исходной ревизией; примеры не импортируются.
 */
export const readReleaseDraft = (key: string, fallback: ReleaseFormValues): DraftResult => {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw !== null) {
      const parsed = DRAFT_SCHEMA.safeParse(JSON.parse(raw));
      if (parsed.success && (parsed.data.revision === 0) === (fallback.revision === 0))
        return { values: parsed.data, error: null };
      return {
        values: fallback,
        error: "Черновик релиза имеет неизвестный формат. Сбросьте его явно, чтобы продолжить.",
      };
    }
    return { values: { ...fallback, planIds: [...fallback.planIds] }, error: null };
  } catch {
    return {
      values: fallback,
      error: "Не удалось восстановить черновик релиза. Исходные данные сохранены.",
    };
  }
};

/**
 * Записывает ввод отдельно от подтверждённого релиза.
 */
export const writeReleaseDraft = (key: string, values: ReleaseFormValues): string | null => {
  try {
    sessionStorage.setItem(
      key,
      JSON.stringify({ ...values, description: values.description.split("\n") }),
    );
    return null;
  } catch {
    return "Черновик не сохранился в браузере. Не закрывайте форму до сохранения релиза.";
  }
};

/**
 * Очищает подтверждённый либо явно отброшенный черновик этого редактора.
 */
export const clearReleaseDraft = (key: string): void => {
  sessionStorage.removeItem(key);
};
