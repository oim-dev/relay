import { CommanderError } from "commander";
import { AppError, asAppError } from "@relay/core/shared/errors";
import type { GlobalOptions, Runtime } from "./context.js";
import { outputOptions } from "./context.js";
import { printError } from "./output.js";
import { createProgram } from "./program.js";
import type { Command } from "commander";
import { commandPath } from "./command.js";

function argumentError(error: CommanderError): string {
  const message = error.message.replace(/^error: /, "");
  return message
    .replace(/unknown option '([^']+)'/g, "Неизвестный параметр «$1»")
    .replace(/unknown command '([^']+)'/g, "Неизвестная команда «$1»")
    .replace(/required option '([^']+)' not specified/g, "Не указан обязательный параметр «$1»")
    .replace(/option '([^']+)' argument missing/g, "Не указано значение параметра «$1»")
    .replace(/missing required argument '([^']+)'/g, "Отсутствует обязательный аргумент «$1»")
    .replace(
      /option '([^']+)' argument '([^']+)' is invalid\./g,
      "Недопустимое значение «$2» параметра «$1».",
    )
    .replace(/argument '([^']+)' is invalid\./g, "Недопустимый аргумент «$1».")
    .replace(/Allowed choices are (.+)\./g, "Допустимые значения: $1.")
    .replace(
      /too many arguments(?: for '([^']+)')?\. Expected (\d+) arguments? but got (\d+)\./g,
      "Слишком много аргументов: ожидалось $2, получено $3.",
    )
    .replace(
      /option '([^']+)' cannot be used with option '([^']+)'/g,
      "Параметры «$1» и «$2» несовместимы",
    )
    .replace(/\(Did you mean (.+)\?\)/g, "Возможно, вы имели в виду: $1?");
}

/** Ранний конфликт учитывает грамматику выбранной команды, а не совпадения токенов. */
function projectArguments(argv: string[], program: Command) {
  let command = program;
  let prefixIndex: number | undefined;
  let explicitProject = false;
  let format: GlobalOptions["format"];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === "--") break;
    if (token.startsWith("-")) {
      const option = [...command.options, ...program.options].find((item) =>
        [item.long, item.short].includes(token.split("=")[0]!),
      );
      const equals = token.indexOf("=");
      const value = equals >= 0 ? token.slice(equals + 1) : argv[index + 1];
      if (option?.long === "--project") explicitProject = true;
      if (option?.long === "--format" && (value === "json" || value === "text")) format = value;
      if (
        equals < 0 &&
        (option?.required || (option?.optional && value !== undefined && !value.startsWith("-")))
      )
        index++;
      continue;
    }
    const child = command.commands.find(
      (item) => item.name() === token || item.aliases().includes(token),
    );
    if (child) command = child;
    else if (
      command === program &&
      prefixIndex === undefined &&
      token !== "help" &&
      index < argv.length - 1
    )
      prefixIndex = index;
  }
  return {
    args:
      prefixIndex === undefined
        ? argv
        : [
            ...argv.slice(0, prefixIndex),
            "--project",
            argv[prefixIndex]!,
            ...argv.slice(prefixIndex + 1),
          ],
    conflict: prefixIndex !== undefined && explicitProject,
    format,
    command,
  };
}

/** Возвращаем код вместо process.exit, чтобы вывод успел сброситься и CLI был тестируемым. */
export async function runCli(argv: string[], runtime: Runtime): Promise<number> {
  const program = createProgram(runtime);
  let earlyOptions: GlobalOptions = {};
  try {
    const prepared = projectArguments(argv, program);
    earlyOptions = prepared.format ? { format: prepared.format } : {};
    if (prepared.conflict)
      throw new AppError(
        "INVALID_ARGUMENT",
        "Укажите проект один раз: префиксом или --project",
        2,
        {
          hint: `Синтаксис и примеры: ${commandPath(prepared.command)} --help`,
        },
      );
    await program.parseAsync(prepared.args, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    const options = { ...earlyOptions, ...program.opts<GlobalOptions>() };
    const output = outputOptions(runtime, options);
    const failure =
      error instanceof CommanderError
        ? new AppError("INVALID_ARGUMENT", argumentError(error), 2, {
            hint: `Синтаксис и примеры: ${runtime.helpCommand ?? "npx @oim-dev/relay-cli"} --help`,
          })
        : asAppError(error);
    printError(runtime.stdout, failure, output);
    return failure.exitCode;
  }
}
