import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { publishTaskCommentSchema } from "@relay/core/domain/board-task";
import type { TaskCommentsQuery } from "@relay/core/domain/board-task";
import { parse } from "@relay/core/domain/validation";
import { AppError } from "@relay/core/shared/errors";
import { commandGroup, registerCommand } from "../command.js";
import { author } from "../context.js";
import type { Runtime } from "../context.js";
import { integer } from "../options.js";
import { nativeQuery, nativePageResult, readTextFields, textOption } from "../command-kit.js";
import { taskInvocation } from "../presentation/board-tasks.js";
import {
  taskActivityText,
  taskActivityEventText,
  taskCommentSavedText,
} from "../presentation/task-activity.js";

/** Предметные команды обсуждений карточки. */
export function registerTaskActivity(parent: Command, runtime: Runtime): void {
  const group = commandGroup(parent, {
    name: "comment",
    description: "Обсуждения задачи",
    details:
      "Списки содержат компактные записи, полный Markdown читается адресно. Курсор сохраняет снимок и фильтры.",
    examples: [["npx @oim-dev/relay-cli task comment list PRODUCT-1", "Прочитать обсуждения"]],
  });
  registerCommand<
    Omit<TaskCommentsQuery, "limit" | "after" | "cursor"> & {
      by?: string;
      limit?: number;
      after?: number;
      cursor?: string;
    }
  >(group, runtime, {
    name: "list <reference>",
    description: "Прочитать страницу ленты",
    arguments: { reference: "ID или текущий/прежний ключ задачи" },
    details:
      "Размер первой страницы берётся из настроек вывода, либо --limit. После известной границы используйте --after. Пустая страница с курсором имеет продолжение. Курсор CLI сохраняет подключение, задачу, фильтры, размер страницы и исходный курсор снимка ленты; достаточно передать только --cursor. Offset и version не используются.",
    examples: [
      ["npx @oim-dev/relay-cli task comment list PRODUCT-1 --limit 20", "Последние записи"],
    ],
    configure: (command) =>
      command
        .option("--limit <n>", "Размер страницы, 1–100", integer(1, 100))
        .option("--cursor <cursor>", "Курсор продолжения предыдущей страницы")
        .option(
          "--after <n>",
          "Только после последовательного номера",
          integer(0, Number.MAX_SAFE_INTEGER),
        )
        .option("--by <name>", "Точное имя автора записей")
        .option("--action <action>", "Совместимый фильтр: только comment-publish"),
    run: async (context, input) => {
      const { by, after, action } = input.options;
      const command = ["task", "comment", "list", input.argument()];
      const filters = { by, after, action };
      const controls = nativeQuery(context, input.options, command, filters, "snapshot");
      const query = {
        ...controls,
        ...(filters.after === undefined ? {} : { after: filters.after }),
        ...(filters.by === undefined ? {} : { actor: filters.by }),
        ...(filters.action === undefined ? {} : { action: filters.action }),
      };
      const data = await context.backend.boardTasks
        .listComments(input.argument(), query)
        .catch((error: unknown) => {
          if (
            controls.cursor !== undefined &&
            error instanceof AppError &&
            error.code === "VALIDATION_ERROR"
          ) {
            // Сохраняем исходный код, подробности и причину отказа Backend; запрос не повторяем.
            error.message +=
              "\nНачните список заново без --cursor. Укажите исходные фильтры и размер страницы в том же проекте.";
          }
          throw error;
        });
      return {
        data,
        page: nativePageResult(context, command, filters, controls, data, "snapshot"),
        text: (format) =>
          taskActivityText(data, input.argument(), query, format, taskInvocation(context)),
      };
    },
  });
  registerCommand(group, runtime, {
    name: "get <reference> <entryId>",
    description: "Прочитать полное содержание записи",
    arguments: { reference: "ID или ключ задачи", entryId: "Номер записи из списка" },
    details: "Markdown рендерится для человека; --format json возвращает точный машинный ответ.",
    examples: [["npx @oim-dev/relay-cli task comment get PRODUCT-1 1", "Прочитать запись"]],
    run: async (context, input) => {
      const data = await context.backend.boardTasks.getComment(input.argument(), input.argument(1));
      return {
        data,
        text: (format) =>
          taskActivityEventText(data, format, input.argument(), taskInvocation(context)),
      };
    },
  });
  registerCommand<{ title: string; description: string; role: string; requestId?: string }>(
    group,
    runtime,
    {
      name: "add <reference>",
      description: "Опубликовать сообщение от своего имени",
      arguments: { reference: "ID или ключ задачи" },
      details:
        "Имя задаётся глобальным --actor. Не требует ревизии задачи. После потери ответа прочитайте обсуждение. Повторная публикация, в том числе с тем же request-id, может создать новое сообщение; результат для повтора не сохраняется.",
      examples: [
        [
          'npx @oim-dev/relay-cli task comment add PRODUCT-1 --actor worker-api --role worker --title "Проверка" --description "## Результат\nПроверено." --request-id report-1',
          "Опубликовать отчёт",
        ],
      ],
      configure: (command) => {
        command
          .requiredOption("--title <text>", "Обязательный однострочный заголовок")
          .requiredOption("--role <role>", "Роль: operator, orchestrator или worker")
          .option(
            "--request-id <id>",
            "Идентификатор корреляции, не дедупликации; по умолчанию UUID",
          );
        textOption(command, "description", "Обязательное полное сообщение в Markdown");
      },
      run: async (context, input) => {
        const { role, title, requestId } = input.options;
        const text = await readTextFields(context, input.options, ["description"]);
        const command = parse(
          publishTaskCommentSchema,
          {
            title,
            ...text,
            actorRole: role,
            actor: author(context),
            requestId: requestId ?? randomUUID(),
          },
          "сообщение",
        );
        const data = await context.backend.boardTasks.publishComment(input.argument(), command);
        return {
          data,
          text: (format) =>
            taskCommentSavedText(data, taskInvocation(context), input.argument(), title, format),
        };
      },
    },
  );
}
