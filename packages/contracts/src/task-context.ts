import { z } from "zod";
import { entityDetailSchema, entityRefSchema } from "./entities.js";
import {
  acceptanceCriterionSchema,
  boardTaskSummarySchema,
  boardTaskViewSchema,
} from "./entities/board-task.js";

/**
 * Версия формы контекста исполнения задачи. Меняется только при несовместимом изменении
 * ответа; новые необязательные поля версию не меняют.
 */
export const TASK_CONTEXT_CONTRACT_VERSION = 1 as const;
/** Возможность HTTP-проекта: `GET /board-tasks/:reference/context`. */
export const TASK_CONTEXT_CAPABILITY = "relay-task-context-v1";
/** Технические пределы одного ответа; превышение — ошибка, а не усечённая выборка. */
export const TASK_CONTEXT_LIMITS = { records: 1000, bytes: 16 * 1024 * 1024 } as const;

export const taskContextQuerySchema = z
  .strictObject({
    targetDocuments: z
      .enum(["true", "false"])
      .optional()
      .describe(
        "true — включить также документы, прикреплённые к целям задачи, их фичам, сценариям и приложениям; по умолчанию только документы самой задачи",
      ),
  })
  .describe("Параметры чтения контекста исполнения задачи");

export const taskContextReasonSchema = z
  .strictObject({
    code: z
      .enum([
        "task-target",
        "target-feature",
        "target-scenario",
        "target-application",
        "product-passport",
        "task-document",
        "target-document",
      ])
      .describe(
        "Причина включения: task-target — цель «Реализует» задачи; target-feature/target-scenario — требование, которому принадлежит цель; target-application — приложение реализации; product-passport — паспорт продукта; task-document — документ, прикреплённый к задаче; target-document — документ, прикреплённый к цели или её требованию",
      ),
    from: entityRefSchema
      .nullable()
      .describe("Запись, через которую включена эта; null — сама задача или проект"),
  })
  .describe("Одно основание включения записи в контекст");

export const taskContextRecordSchema = z
  .strictObject({
    record: entityDetailSchema.describe(
      "Полная запись в том же виде, что у чтения сущности: ключ, ревизия и полный Markdown",
    ),
    reasons: z
      .array(taskContextReasonSchema)
      .min(1)
      .describe("Все основания включения; запись в ответе не повторяется"),
  })
  .describe("Запись контекста с основаниями включения");

export const taskContextSchema = z
  .strictObject({
    contractVersion: z.literal(TASK_CONTEXT_CONTRACT_VERSION).describe("Версия формы этого ответа"),
    task: boardTaskViewSchema
      .extend({
        criteria: z
          .array(acceptanceCriterionSchema)
          .describe("Все критерии приёмки с постоянными ID и полным Markdown, в порядке задачи"),
      })
      .describe("Полная задача и её критерии"),
    targets: z
      .array(taskContextRecordSchema)
      .describe("Явные цели задачи (FI/SI, фичи, сценарии) в порядке productLinks"),
    requirements: z
      .array(taskContextRecordSchema)
      .describe("Фичи и сценарии, которым принадлежат цели, если они не являются целями сами"),
    applications: z.array(taskContextRecordSchema).describe("Приложения реализаций из целей"),
    product: taskContextRecordSchema
      .nullable()
      .describe(
        "Паспорт продукта; незаполненный паспорт возвращается с ревизией 0, null — только если паспорт недоступен",
      ),
    documents: z
      .array(taskContextRecordSchema)
      .describe(
        "Прикреплённые неархивные документы с полным содержанием: к задаче, а при targetDocuments=true — и к целям",
      ),
    dependencies: z
      .array(boardTaskSummarySchema)
      .describe("Прямые зависимости задачи без полного Markdown, в порядке задачи"),
    children: z.array(boardTaskSummarySchema).describe("Прямые подзадачи без полного Markdown"),
    consistency: z
      .string()
      .describe(
        "Отпечаток всего ответа: меняется при любом изменении содержания, включая вычисляемые блокеры, статусы и ключи ссылок",
      ),
    complete: z
      .literal(true)
      .describe("Успешный ответ всегда полный; превышение пределов возвращает CONTEXT_TOO_LARGE"),
    limits: z
      .strictObject({
        records: z.number().int().positive().describe("Предел числа записей ответа"),
        bytes: z.number().int().positive().describe("Предел размера ответа в байтах UTF-8"),
      })
      .describe("Действующие пределы этого чтения"),
  })
  .describe(
    "Контекст исполнения задачи: всё, что исполнителю нужно прочитать по задаче, одним согласованным чтением",
  );

export type TaskContextQuery = z.input<typeof taskContextQuerySchema>;
export type TaskContextReason = z.infer<typeof taskContextReasonSchema>;
export type TaskContextRecord = z.infer<typeof taskContextRecordSchema>;
export type TaskContext = z.infer<typeof taskContextSchema>;
