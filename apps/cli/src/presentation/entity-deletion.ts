import type {
  EntityDeleted,
  EntityDeletionPreview,
  EntitySummary,
} from "@relay/contracts/entities";
import { cardText, listText, receiptText, type OutputCommand } from "./common.js";
import type { TextOptions } from "./theme.js";

function cascadeText(items: readonly EntitySummary[], options: TextOptions): string {
  return listText(
    {
      title: "",
      items: items.map((item) => ({
        key: "",
        title: item.title,
        fields: [
          ["Ключ", item.key, "opaque"],
          ["Вид", item.ref.kind, "opaque"],
          ["ID", item.ref.id, "opaque"],
          ["Ревизия", item.revision, "opaque"],
        ],
      })),
      emptyMessage: "Нет записей.",
    },
    options,
  );
}

/** Полный состав, без страниц и усечения; relations — только счётчик, не список рёбер. */
export function deletionPreviewText(
  data: EntityDeletionPreview,
  options: TextOptions,
  command: string,
  actorAvailable: boolean,
): string {
  return cardText(
    {
      title: `Предпросмотр удаления · ${data.target.title}`,
      fields: [
        ["Цель", data.target.key, "opaque"],
        ["Вид", data.target.ref.kind, "opaque"],
        ["ID", data.target.ref.id, "opaque"],
        ["Ревизия", data.target.revision, "opaque"],
        ["Версия", data.version, "opaque"],
        ["Будет удалено", data.deleted.length, "opaque"],
        ["Сохранятся со снятыми ссылками", data.detached.length, "opaque"],
        ["Будет отозвано связей", data.relations, "opaque"],
      ],
      sections: [
        { title: "Полный каскад удаления", body: cascadeText(data.deleted, options) },
        {
          title: "Сохраняемые записи со снятием ссылок",
          body: cascadeText(data.detached, options),
        },
      ],
      commands: [
        {
          label: actorAvailable
            ? "Данные не изменены. Только после проверки всего каскада: подтвердить удаление (без восстановления)"
            : "Данные не изменены. Для удаления укажите --actor или RELAY_ACTOR; условия подтверждения:",
          command,
        },
      ],
    },
    options,
  );
}

export function entityDeletedText(
  data: EntityDeleted,
  options: TextOptions,
  commands: readonly OutputCommand[],
): string {
  return receiptText(
    {
      title: "Каскад удалён",
      fields: [
        ["Вид цели", data.ref.kind, "opaque"],
        ["ID цели", data.ref.id, "opaque"],
        ["Удалено", data.deleted, "opaque"],
        ["Сохранено со снятыми ссылками", data.detached, "opaque"],
        ["Отозвано связей", data.relations, "opaque"],
        ["ID запроса (корреляция)", data.requestId, "opaque"],
      ],
      commands,
    },
    options,
  );
}
