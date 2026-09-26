import type { z } from "zod";
import type {
  CRITERION_SCHEMA,
  CRITERION_SUMMARY_SCHEMA,
  CRITERION_VIEW_SCHEMA,
  CRITERIA_PAGE_SCHEMA,
} from "../config/acceptance.schema";

/** Критерий со всеми описаниями. */
export type AcceptanceCriterion = z.infer<typeof CRITERION_SCHEMA>;
/** Строка списка критериев. */
export type CriterionSummary = z.infer<typeof CRITERION_SUMMARY_SCHEMA>;
/** Полное содержание с ревизией задачи. */
export type CriterionView = z.infer<typeof CRITERION_VIEW_SCHEMA>;
/** Страница критериев. */
export type CriteriaPage = z.infer<typeof CRITERIA_PAGE_SCHEMA>;
/** Текстовое содержание критерия. */
export type CriterionContent = {
  /** Однострочный заголовок. */
  title: string;
  /** Краткий обычный текст. */
  summary: string;
  /** Полный Markdown. */
  description: string;
};
/** Защита записи от конфликтов и повторов. */
type CriterionWrite = {
  /** Прочитанная ревизия задачи. */
  ifRevision: number;
  /** Корреляция HTTP-запроса, не ключ дедупликации. */
  requestId: string;
};
/** Предметное изменение одного критерия. */
export type ChangeCriterionInput = CriterionWrite &
  (
    | ({ /** Добавление. */ action: "add" } & CriterionContent)
    | ({
        /** Редактирование текста. */ action: "update";
        /** ID критерия. */ criterionId: string;
      } & CriterionContent)
    | {
        /** Выполнение. */ action: "complete";
        /** ID критерия. */ criterionId: string;
        /** Явное состояние. */ completed: boolean;
      }
    | { /** Удаление. */ action: "remove"; /** ID критерия. */ criterionId: string }
  );
