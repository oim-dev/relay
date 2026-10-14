import type { Command } from "commander";
import type { Runtime } from "../context.js";
import { registerCommand, type CommandDefinition } from "../command.js";
import { rememberTaskFailure, taskInvocation } from "../presentation/board-tasks.js";

/** Адрес восстановления принадлежит вызову CLI, а не машинным details предметной ошибки. */
export function registerTaskCommand<Options extends object = Record<string, never>>(
  parent: Command,
  runtime: Runtime,
  definition: CommandDefinition<Options>,
): void {
  registerCommand<Options>(parent, runtime, {
    ...definition,
    async run(context, input) {
      try {
        return await definition.run(context, input);
      } catch (error) {
        rememberTaskFailure(error, {
          reference: input.optionalArgument(),
          action: definition.name.split(" ")[0]!,
          group: parent.name(),
          invoke: taskInvocation(context),
        });
        throw error;
      }
    },
  });
}
