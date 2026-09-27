import { Readable, Writable } from "node:stream";
import { createProgram } from "../../../apps/cli/src/program.ts";
import { runtime } from "../../../apps/cli/src/context.ts";

/** Экранирует содержимое ячейки, не меняя смысл справочного значения. */
function cell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

/** Дополняет описание ограничениями, которые использует сам Commander. */
function optionDescription(option) {
  let description = option.description;
  if (option.argChoices) description += ` Значения: ${option.argChoices.join(", ")}.`;
  if (option.defaultValue !== undefined)
    description += ` По умолчанию: ${JSON.stringify(option.defaultValue)}.`;
  return cell(description.replace(/(?<![\w/-])relay-cli(?= )/g, "npx @oim-dev/relay-cli"));
}

/** Строит справочник из тех же определений, которые предоставляют --help. */
function commandReference() {
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const context = runtime(Readable.from([]), sink);
  const program = createProgram(context);
  const lines = [
    "# Команды Relay CLI",
    "",
    "Справочник сформирован из зарегистрированных команд. Порядок работы — в [главном руководстве](../../skill.md), семантика — в [CLI](CLI.md), примеры — в [сценариях](../agent/EXAMPLES.md).",
    "",
    "Запускайте только через `npx @oim-dev/relay-cli`. В workspace указывайте проект префиксом либо `--project`. Конкретный help: `npx @oim-dev/relay-cli <команда> --help`.",
    "",
    "## Общие параметры",
    "",
    "| Параметр | Назначение |",
    "| --- | --- |",
    ...program.options.map(
      (option) => `| \`${cell(option.flags)}\` | ${optionDescription(option)} |`,
    ),
    "",
  ];
  const visit = (command, parents) => {
    const path = [...parents, command.name()];
    if (command.commands.length > 0) {
      for (const child of command.commands) visit(child, path);
      return;
    }
    lines.push(
      `## ${path.join(" ")}`,
      "",
      `**Синтаксис:** \`npx @oim-dev/relay-cli ${path.join(" ")} ${command.usage()}\`.`,
      "",
      command.description(),
      "",
    );
    const argumentsList = command.createHelp().visibleArguments(command);
    if (argumentsList.length > 0) {
      lines.push("| Аргумент | Назначение |", "| --- | --- |");
      for (const argument of argumentsList)
        lines.push(`| \`${cell(argument.name())}\` | ${cell(argument.description)} |`);
      lines.push("");
    }
    if (command.options.length > 0) {
      lines.push("| Параметр | Назначение |", "| --- | --- |");
      for (const option of command.options)
        lines.push(`| \`${cell(option.flags)}\` | ${optionDescription(option)} |`);
      lines.push("");
    }
  };
  for (const command of program.commands) visit(command, []);
  sink.destroy();
  return lines.join("\n");
}

/** Генераторы ограничены известными справочниками продукта. */
export function generateReference(name) {
  if (name === "cli") return commandReference();
  throw new Error(`Неизвестный генератор справочника: ${name}`);
}
