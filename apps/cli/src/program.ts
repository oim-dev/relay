import { Command, Option } from "commander";
import { registerProject } from "./commands/project.js";
import { registerProjects } from "./commands/projects.js";
import { registerProduct } from "./commands/product.js";
import { registerBoardTasks } from "./commands/board-tasks.js";
import { registerGraph } from "./commands/graph.js";
import { registerEntities } from "./commands/entities.js";
import { registerStorage } from "./commands/storage.js";
import { registerPlanning } from "./commands/planning.js";
import type { Runtime } from "./context.js";
import { packageVersion } from "./package-info.js";
import { addCommandHelp, commandPath, groupHelpAction } from "./command.js";

export function createProgram(runtime: Runtime): Command {
  const program = new Command("npx @oim-dev/relay-cli")
    .description("Relay: сущности, связи и работа одного проекта или workspace")
    .version(packageVersion, "-V, --version", "Показать версию CLI")
    .helpOption("-h, --help", "Справка, параметры и примеры")
    .option(
      "--config <path>",
      "Путь к .relay/config.json или relay.workspace.json; приоритет над RELAY_CONFIG",
    )
    .option(
      "--project <name>",
      "Имя проекта из workspace; также npx @oim-dev/relay-cli <проект> <команда>",
    )
    .option("--server-url <url>", "Адрес сервера; приоритет над RELAY_SERVER_URL и server.url")
    .option("--local", "Работать напрямую с локальным Core, игнорируя HTTP-настройки")
    .option("--actor <id>", "Автор записи, например human; приоритет над RELAY_ACTOR")
    .addOption(new Option("--format <format>", "Формат ответа").choices(["json", "text"]))
    .showSuggestionAfterError(true)
    .exitOverride()
    .configureOutput({ writeOut: (text) => runtime.stdout.write(text), writeErr: () => {} });
  registerProject(program, runtime);
  registerProjects(program, runtime);
  registerProduct(program, runtime);
  registerPlanning(program, runtime);
  registerBoardTasks(program, runtime);
  registerEntities(program, runtime);
  registerGraph(program, runtime);
  registerStorage(program, runtime);
  addCommandHelp(program, {
    details:
      "Режимы: .relay/config.json → local; relay.workspace.json → workspace.\nВ workspace укажите проект: npx @oim-dev/relay-cli <проект> <команда>. Рабочие операции идут через общий сервер.\nВ local URL выбирает HTTP, отсутствие URL — Core; --local явно выбирает файлы.\nURL: --server-url → RELAY_SERVER_URL → server.url. Сервер поставляется отдельно в @oim-dev/relay-server.\nЗадачи адресуются постоянным ID или ключом доски, например PRODUCT-1. Автор записи: --actor или RELAY_ACTOR.\nСправка: npx @oim-dev/relay-cli <команда> --help. Обычный вывод — текст; --format json выбирает машинный ответ.",
    examples: [
      ["npx @oim-dev/relay-cli project get", "Прочитать проект"],
      ["npx @oim-dev/relay-cli product get", "Прочитать паспорт продукта"],
      ["npx @oim-dev/relay-cli init", "Подготовить текущий проект"],
      [
        'npx @oim-dev/relay-cli task create --board product --title "Реализовать API" --actor human',
        "Создать первую задачу",
      ],
      [
        "npx @oim-dev/relay-cli task list --completion unfinished",
        "Посмотреть незавершённые задачи",
      ],
      [
        "npx @oim-dev/relay-cli inspect graph context PRODUCT-1",
        "Прочитать связи и контекст задачи",
      ],
    ],
  });
  runtime.helpCommand = program.name();
  const trackCommand = (command: Command) => {
    command.hook("preSubcommand", (_parent, child) => {
      runtime.helpCommand = commandPath(child);
    });
    for (const child of command.commands) trackCommand(child);
  };
  trackCommand(program);
  groupHelpAction(program);
  return program;
}
