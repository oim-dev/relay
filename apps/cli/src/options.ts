import { InvalidArgumentError, Option } from "commander";
import type { Command } from "commander";
import type { PageOptions } from "./queries/pagination.js";
import type { CommandContext } from "./context.js";
import { randomUUID } from "node:crypto";
import { requestIdSchema } from "@relay/contracts/primitives";
import { parse } from "@relay/core/domain/validation";

export interface RequestOptions {
  requestId?: string;
}
export function recordOptions(command: Command): Command {
  return command.option(
    "--request-id <id>",
    "Идентификатор корреляции запроса, не предотвращает повторную запись",
    (value) => parse(requestIdSchema, value, "идентификатор запроса"),
  );
}
export function requestId(options: RequestOptions): string {
  return options.requestId ?? randomUUID();
}

export interface PageControls {
  limit?: number;
  cursor?: string;
}
export interface PagingOptions extends PageControls {
  all?: boolean;
}
export interface RevisionOptions {
  ifRevision?: number;
}

export function integer(min: number, max: number) {
  return (value: string): number => {
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      throw new InvalidArgumentError(`Ожидается целое число от ${min} до ${max}`);
    }
    return parsed;
  };
}

export function csv(value: string): string[] {
  return value === "" ? [] : value.split(",").map((item) => item.trim());
}

export function cursorOptions(command: Command): Command {
  return command
    .option("--limit <count>", "Размер страницы, от 1 до 100", integer(1, 100))
    .option("--cursor <cursor>", "Курсор из предыдущего ответа; фильтры должны совпадать");
}

export function pageOptions(command: Command): Command {
  return cursorOptions(command).addOption(
    new Option("--all", "Все результаты одним ответом; лимит --max-bytes сохраняется").conflicts([
      "limit",
      "cursor",
    ]),
  );
}

export function pageFrom(context: CommandContext, options: PagingOptions): PageOptions {
  return {
    limit: options.limit ?? context.workspace.config.output.defaultLimit,
    ...context.output,
    ...(context.globals.project
      ? { project: context.globals.project, storage: context.workspace.root }
      : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.all ? { all: true } : {}),
  };
}

export function revisionOption(command: Command): Command {
  return command.option(
    "--if-revision <revision>",
    "Ожидаемая версия карточки",
    integer(1, Number.MAX_SAFE_INTEGER),
  );
}
