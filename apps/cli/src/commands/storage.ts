import type { Command } from "commander";
import { StorageService } from "@relay/core/application/storage/service";
import { AppError } from "@relay/core/shared/errors";
import { commandGroup, registerCommand } from "../command.js";
import type { Runtime } from "../context.js";
import { author } from "../context.js";
import { randomUUID } from "node:crypto";

/** Явное обслуживание выбранной файловой базы, с собственным результатом для человека. */
export function registerStorage(program: Command, runtime: Runtime): void {
  const group = commandGroup(program, {
    name: "storage",
    description: "Формат единого хранилища и восстановление индексов",
    details:
      "Обслуживание выполняется локально для выбранного .relay/config.json. Обычное открытие использует готовые индексы и не перестраивает базу.",
    examples: [
      ["relay-cli --local storage migrate", "Явно перенести прежнюю базу"],
      [
        "relay-cli --local storage reindex",
        "Восстановить производные индексы после внешних изменений",
      ],
    ],
  });
  registerCommand(group, runtime, {
    name: "migrate",
    description: "Перенести базу в единый формат",
    details:
      "Перед переносом остановите старые версии клиентов. ID, ключи, текущие тексты, ревизии, комментарии и квитанции сохраняются. Незавершённый WAL восстанавливается; повтор переноса не дублирует данные.",
    examples: [
      [
        "relay-cli --local --config .relay/config.json storage migrate",
        "Перенести выбранный проект",
      ],
    ],
    run: async (context) => {
      const workspace = context.backend.localWorkspace;
      if (!workspace)
        throw new AppError(
          "LOCAL_REQUIRED",
          "Для обслуживания укажите --local и проектный --config",
        );
      const data = await new StorageService(workspace).migrate();
      return {
        data,
        text: data.migrated
          ? `Единое хранилище готово.\nПеренесено записей: ${data.entities}\nФормат: ${data.format}`
          : "Проект уже использует компактное единое хранилище. Перенос не требуется.",
      };
    },
  });
  registerCommand(group, runtime, {
    name: "reindex",
    description: "Перестроить адреса, карточки и связи из постоянных данных",
    details:
      "Используйте после Git-слияния, ручной правки либо потери индекса. Предметные данные не удаляются. Команда работает и при отсутствующем заголовке индекса.",
    examples: [["relay-cli --local storage reindex", "Восстановить индексы проекта"]],
    run: async (context) => {
      const workspace = context.backend.localWorkspace;
      if (!workspace)
        throw new AppError(
          "LOCAL_REQUIRED",
          "Для обслуживания укажите --local и проектный --config",
        );
      const data = await new StorageService(workspace).reindex();
      return {
        data,
        text: `Индексы единого хранилища восстановлены.\nДействующих связей: ${data.edges}\nРевизия графа: ${data.revision}`,
      };
    },
  });
  registerCommand<{ requestId?: string }>(group, runtime, {
    name: "reconcile-relations",
    description: "Согласовать сохранённые связи Core с предметными линками существующих сущностей",
    details:
      "Явное обслуживание единого формата после обновления: добавляет недостающие и отзывает лишние связи предметных групп. Сохраняет ID неизменённых связей, независимые диагностические рёбра и ревизии сущностей. Все изменения публикуются одной транзакцией. После потери ответа повторите с тем же request-id.",
    examples: [
      [
        "relay-cli --local --actor agent storage reconcile-relations --request-id relations-v1",
        "Согласовать предметные связи проекта",
      ],
    ],
    configure: (command) =>
      command.option("--request-id <id>", "Ключ безопасного повтора; по умолчанию генерируется"),
    run: async (context, input) => {
      const workspace = context.backend.localWorkspace;
      if (!workspace)
        throw new AppError(
          "LOCAL_REQUIRED",
          "Для обслуживания укажите --local и проектный --config",
        );
      const data = await new StorageService(workspace).reconcileRelations(
        { requestId: input.options.requestId ?? randomUUID() },
        author(context),
      );
      return {
        data,
        text: `Предметные связи согласованы.\nДобавлено: ${data.added}\nОбновлено: ${data.updated}\nОтозвано: ${data.removed}\nКлюч повтора: ${data.requestId}`,
      };
    },
  });
}
