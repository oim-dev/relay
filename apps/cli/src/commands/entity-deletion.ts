import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { deleteEntitySchema, entityDeletionQuerySchema } from "@relay/contracts/entities";
import type { EntityDeletionQuery } from "@relay/contracts/entities";
import { parse } from "@relay/core/domain/validation";
import { registerCommand } from "../command.js";
import { commandInvocation } from "../command-kit.js";
import { author, type Runtime, type CommandContext } from "../context.js";
import { deletionPreviewText, entityDeletedText } from "../presentation/entity-deletion.js";

/** Подключается явно у предметного владельца; вид и каскад проверяет общий Backend. */
export function registerEntityDeletion(
  group: Command,
  runtime: Runtime,
  subject: {
    kind: EntityDeletionQuery["kind"];
    example: string;
    details: string;
    catalogs: readonly { label: string; args: readonly string[] }[];
  },
): void {
  const { kind, example } = subject;
  const recovery = (context: CommandContext, ref: string, confirming: boolean) => {
    if (context.runtime.recovery)
      context.runtime.recovery.deletion = {
        preview: [kind, "delete-preview", ref],
        catalogs: subject.catalogs,
        confirming,
      };
  };
  registerCommand(group, runtime, {
    name: "delete-preview <ref>",
    description: "Прочитать полный каскад удаления без изменения данных",
    arguments: { ref: "Ключ, алиас или постоянный адрес удаляемой записи" },
    details: `${subject.details} Предпросмотр показывает все удаляемые и сохраняемые записи со снятием ссылок, число отзываемых связей и версию для delete --if-version. До 1000 записей в каждом массиве; превышение — ошибка, не усечение. Страниц нет. Автор для чтения не требуется. Ссылки планов могут блокировать удаление.`,
    examples: [
      [
        `npx @oim-dev/relay-cli ${kind} delete-preview ${example}`,
        "Изучить каскад и версию без удаления",
      ],
    ],
    async run(context, input) {
      recovery(context, input.argument(), false);
      const data = await context.backend.deletion.preview(
        parse(entityDeletionQuerySchema, { kind, ref: input.argument() }, "предпросмотр удаления"),
      );
      const actor = context.globals.actor ?? context.runtime.env.RELAY_ACTOR;
      const command = commandInvocation(
        context,
        actor
          ? [
              kind,
              "delete",
              data.target.key,
              "--if-version",
              data.version,
              ...(!context.globals.actor ? ["--actor", actor] : []),
            ]
          : [kind, "delete", "--help"],
      );
      return { data, text: (options) => deletionPreviewText(data, options, command, !!actor) };
    },
  });
  registerCommand<{ ifVersion: string; requestId?: string }>(group, runtime, {
    name: "delete <ref>",
    description: "Удалить просмотренный каскад по исходной версии",
    arguments: { ref: "Ключ, алиас или постоянный адрес просмотренной записи" },
    details: `${subject.details} Сначала изучите delete-preview. Требуются автор (--actor или RELAY_ACTOR) и исходная --if-version. Нового предпросмотра и автоматических повторов команда не делает. При конфликте заново изучите полный каскад; после потери ответа сначала проверьте оставшиеся каталоги, не повторяйте удаление вслепую. request-id — корреляция, не дедупликация. Восстановления удалённой записи нет.`,
    examples: [
      [
        `npx @oim-dev/relay-cli ${kind} delete ${example} --actor human --if-version VERSION`,
        "Удалить только после проверки каскада; замените VERSION прочитанной версией",
      ],
    ],
    configure: (command) =>
      command
        .requiredOption("--if-version <version>", "Исходная версия из полного delete-preview")
        .option("--request-id <id>", "Корреляция запроса, не защита от повторного удаления"),
    async run(context, input) {
      recovery(context, input.argument(), true);
      const actor = author(context);
      const data = await context.backend.deletion.delete(
        parse(
          deleteEntitySchema,
          {
            kind,
            ref: input.argument(),
            ifVersion: input.options.ifVersion,
            requestId: input.options.requestId ?? randomUUID(),
          },
          "удаление записи",
        ),
        actor,
      );
      const commands = subject.catalogs.map(({ label, args }) => ({
        label,
        command: commandInvocation(context, args),
      }));
      return { data, text: (options) => entityDeletedText(data, options, commands) };
    },
  });
}
