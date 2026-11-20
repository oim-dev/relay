import type { Command } from "commander";
import { API_CONTRACT_VERSION } from "@relay/contracts";
import { TASK_CONTEXT_CONTRACT_VERSION } from "@relay/contracts/task-context";
import { defaultConfig } from "@relay/core/domain/config";
import { createCommand } from "../command.js";
import { outputOptions } from "../context.js";
import type { GlobalOptions, Runtime } from "../context.js";
import { printResult } from "../output.js";
import { packageVersion } from "../package-info.js";
import { cardText } from "../presentation/common.js";

/**
 * Машиночитаемые версии договора для интеграций; проект не открывается.
 * Подкоманда config, а не корневая: новый корневой токен перекрыл бы проект workspace
 * с таким именем.
 */
export function registerContract(program: Command, runtime: Runtime): void {
  const config = program.commands.find((command) => command.name() === "config");
  if (!config) throw new Error("Группа config не зарегистрирована");
  const meta = createCommand(config, {
    name: "contract",
    description: "Показать версии пакета и договора интеграций",
    details:
      "Не открывает проект и не обращается к серверу. contractVersion совпадает с contractVersion в GET /api/v1/health сервера той же версии; taskContextContractVersion — версия формы task context. Интеграции сверяют их до первой записи. -V показывает только версию пакета.",
    examples: [["npx @oim-dev/relay-cli config contract", "Проверить версии договора"]],
  });
  meta.action(async () => {
    const globals = meta.optsWithGlobals<GlobalOptions>();
    runtime.output = outputOptions(runtime, globals, defaultConfig.output);
    const data = {
      package: "@oim-dev/relay-cli",
      version: packageVersion,
      contractVersion: API_CONTRACT_VERSION,
      taskContextContractVersion: TASK_CONTEXT_CONTRACT_VERSION,
    };
    printResult(
      runtime.stdout,
      {
        data,
        text: (options) =>
          cardText(
            {
              title: "Relay CLI",
              fields: [
                ["Пакет", data.package],
                ["Версия", data.version],
                ["Версия договора API", data.contractVersion],
                ["Версия формы task context", data.taskContextContractVersion],
              ],
            },
            options,
          ),
      },
      runtime.output,
    );
  });
}
