import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { integer } from "../options.js";

/** Общие параметры CLI планов и релизов; предметные обработчики остаются у своих команд. */
export type Options = Record<string, unknown>;
export const details =
  "Запись выполняется с автором и прочитанной ревизией. request-id служит только корреляции, результат не сохраняется для повтора. После потери ответа перечитайте состояние; повтор может выполнить новое действие. Старый формат планов и релизов не поддерживается; автоматического переноса нет.";
export const refArgument = { reference: "Ключ или постоянный ID выбранной сущности" };
export const writing = (command: Command) =>
  command.option(
    "--request-id <id>",
    "Идентификатор корреляции, не дедупликации; по умолчанию UUID",
  );
export const revision = (command: Command) =>
  writing(command).requiredOption(
    "--if-revision <n>",
    "Прочитанная ревизия плана или релиза",
    integer(1, Number.MAX_SAFE_INTEGER),
  );
export const filtersOf = ({ limit, cursor, ...filters }: Options) => filters;
export const metadata = (options: Options) => ({
  requestId: options.requestId ?? randomUUID(),
  ifRevision: options.ifRevision,
});
