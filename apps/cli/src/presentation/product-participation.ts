import type {
  ProductParticipationPage,
  ProductParticipationSaved,
} from "@relay/contracts/product-participation";
import type { CommandContext } from "../context.js";
import { commandInvocation } from "../command-kit.js";
import { listText, receiptText, type OutputCommand } from "./common.js";
import { stateLabel } from "./entities.js";
import type { TextOptions } from "./theme.js";

export function participationText(
  data: ProductParticipationPage,
  options: TextOptions,
  context: CommandContext,
): string {
  const first = data.items[0];
  const commands: OutputCommand[] = first
    ? [
        {
          label: "Полное содержание первого вклада; для другого замените ключ",
          command: commandInvocation(context, ["implementation", "get", first.key]),
        },
        {
          label: "Общее требование первого вклада",
          command: commandInvocation(context, [first.target.ref.kind, "get", first.target.key]),
        },
      ]
    : [];
  commands.push({
    label: "Правила атомарной замены всего состава, включая новые FI/SI",
    command: commandInvocation(context, ["application", "participation", "replace", "--help"]),
  });
  return listText(
    {
      title: `Состав ${data.application.key} — ${data.application.title}`,
      filters: [
        ["Проекция", "compact"],
        ["Ревизия состава", data.revision],
        ["Версия для записи", data.version, "opaque"],
      ],
      items: data.items.map((item) => ({
        key: item.key,
        title: item.title,
        details: [
          `${item.implementationTarget === "feature" ? "FI" : "SI"} · ${item.active ? "Участвует" : "Участие снято"}`,
          `Цель: ${item.target.key} · ${item.target.title}`,
          ...(item.active
            ? [`Готовность (расчёт): ${stateLabel("implementation", item.status)}`]
            : []),
          `Совместимая отметка: ${item.savedStatus} (не готовность)`,
          `Ревизия реализации: ${item.revision}`,
        ],
      })),
      emptyMessage:
        data.total === 0
          ? "Реализаций нет. Новый FI/SI можно выбрать атомарно через replace --composition-file."
          : "На этой странице реализаций нет.",
      commands,
    },
    options,
  );
}

export function participationSavedText(
  data: ProductParticipationSaved,
  options: TextOptions,
  context: CommandContext,
): string {
  return receiptText(
    {
      title: `Активный состав заменён: ${data.application.key}`,
      fields: [
        ["Приложение", data.application.title],
        ["Ревизия состава", data.revision],
        ["Выбрано реализаций", data.selected],
      ],
      commands: [
        {
          label: "Перечитать состав и исходные условия следующего изменения",
          command: commandInvocation(context, [
            "application",
            "participation",
            "list",
            data.application.key,
            "--projection",
            "compact",
          ]),
        },
      ],
    },
    options,
  );
}
