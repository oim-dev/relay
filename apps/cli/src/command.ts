import type { Command } from "commander";
import type { Result } from "./queries/result.js";
import { invariant } from "@relay/core/shared/errors";
import { action } from "./context.js";
import type { CommandContext, Runtime } from "./context.js";
import { formatHelpExample } from "./help-example.js";

export interface CommandHelp {
  name: string;
  description: string;
  details?: string;
  arguments?: Record<string, string>;
  examples?: readonly (readonly [command: string, explanation: string])[];
  configure?: (command: Command) => unknown;
}

export interface CommandInput<Options> {
  options: Options;
  argument(index?: number): string;
  optionalArgument(index?: number): string | undefined;
}

export interface CommandDefinition<Options> extends CommandHelp {
  run: (context: CommandContext, input: CommandInput<Options>) => Promise<Result>;
}

export function commandPath(command: Command): string {
  return command.parent
    ? `${commandPath(command.parent)} ${command.name()}`
    : "npx @oim-dev/relay-cli";
}

export function addCommandHelp(
  command: Command,
  help: Pick<CommandHelp, "details" | "examples">,
): void {
  command.addHelpText("after", () =>
    [
      "",
      help.details ?? "",
      "",
      ...(help.examples?.length ? ["Примеры:"] : []),
      ...(help.examples ?? []).flatMap(([example, explanation]) => [
        `  ${explanation}`,
        formatHelpExample(example, "  "),
        "",
      ]),
    ].join("\n"),
  );
}

/** Один источник описания команды: синтаксис, параметры, объяснение и рабочие примеры. */
export function createCommand(parent: Command, definition: CommandHelp): Command {
  const command = parent
    .command(definition.name)
    .description(definition.description, definition.arguments ?? {});
  // Commander хранит старую карту отдельно; описание должно быть доступно и в метаданных аргумента.
  for (const argument of command.registeredArguments)
    argument.description = definition.arguments?.[argument.name()] ?? argument.description;
  command.allowExcessArguments(false);
  command.configureHelp({ showGlobalOptions: true });
  definition.configure?.(command);
  addCommandHelp(command, definition);
  return command;
}

/** Обработчик получает готовый контекст и ввод, не замыкается на объекте Commander. */
export function registerCommand<Options extends object = Record<string, never>>(
  parent: Command,
  runtime: Runtime,
  definition: CommandDefinition<Options>,
): void {
  const command = createCommand(parent, definition);
  action(command, runtime, (context) =>
    definition.run(context, {
      options: command.opts() as Options,
      argument(index = 0) {
        const value: unknown = command.processedArgs[index];
        invariant(
          typeof value === "string",
          "INVALID_ARGUMENT",
          `Отсутствует аргумент. Справка: ${commandPath(command)} --help`,
        );
        return value;
      },
      optionalArgument(index = 0) {
        return command.processedArgs[index] as string | undefined;
      },
    }),
  );
}

export function commandGroup(parent: Command, definition: CommandHelp): Command {
  const command = createCommand(parent, definition);
  groupHelpAction(command);
  return command;
}

export function groupHelpAction(command: Command): void {
  command.allowExcessArguments(true).action(() => {
    if (command.args.length) {
      command.error(
        `Неизвестная команда «${command.args[0]}». Доступны: ${command.commands.map((child) => child.name()).join(", ")}`,
        { code: "commander.unknownCommand" },
      );
    }
    command.help();
  });
}
