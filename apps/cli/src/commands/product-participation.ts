import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { productParticipationReplaceSchema } from "@relay/contracts/product-participation";
import { parse } from "@relay/core/domain/validation";
import { AppError, invariant } from "@relay/core/shared/errors";
import { commandGroup, registerCommand } from "../command.js";
import { author } from "../context.js";
import type { Runtime } from "../context.js";
import {
  paging,
  offsetQuery,
  pageResult,
  commandInvocation,
  textOption,
  readTextFields,
} from "../command-kit.js";
import { revisionOption, subject } from "./product.js";
import { listText } from "../presentation/common.js";
import { stateLabel } from "../presentation/entities.js";
import {
  participationText,
  participationSavedText,
} from "../presentation/product-participation.js";

/** Совместимый полный ответ и явная компактная проекция; составом владеет Core. */
export function registerParticipation(parent: Command, runtime: Runtime) {
  const group = commandGroup(parent, {
    name: "participation",
    description: "Активный состав приложения",
    details:
      "Снятые реализации сохраняют адреса и содержание; повторный выбор возвращает участие. Полный состав с новыми FI/SI можно сохранить атомарно через replace --composition-file.",
    examples: [
      [
        "npx @oim-dev/relay-cli application participation list WEB --projection compact",
        "Прочитать состав и условия записи",
      ],
    ],
  });
  registerCommand<{ cursor?: string; limit?: number; projection?: string }>(group, runtime, {
    name: "list <ref>",
    arguments: { ref: "Ключ или ID приложения" },
    description: "Прочитать участие и ревизию состава",
    details:
      "Включает снятые реализации. Для replace нужны ревизия состава и версия из этого ответа. --projection compact читает серверную страницу без полных описаний; version — для записи, snapshotVersion — guard страниц. Без проекции читается полный состав; полное содержание отдельного вклада — implementation get.",
    examples: [
      [
        "npx @oim-dev/relay-cli application participation list WEB --projection compact",
        "Прочитать компактную страницу и исходные условия записи",
      ],
    ],
    configure: (command) =>
      paging(command).option(
        "--projection <mode>",
        "Проекция: full (совместимый ответ по умолчанию) / compact",
      ),
    async run(context, input) {
      const command = ["application", "participation", "list", input.argument()];
      const filters = {
        ...(input.options.projection !== undefined ? { projection: input.options.projection } : {}),
      };
      const query = offsetQuery(context, input.options, command, filters);
      invariant(
        filters.projection === undefined || ["full", "compact"].includes(filters.projection),
        "INVALID_ARGUMENT",
        "Укажите --projection full или compact",
      );
      if (filters.projection === "compact") {
        const data = await context.backend.product.participation({
          application: input.argument(),
          ...query,
        });
        return {
          data,
          page: pageResult(context, command, filters, query, {
            ...data,
            version: data.snapshotVersion,
          }),
          text: (options) => participationText(data, options, context),
        };
      }
      const application = await subject(context, "application", input.argument());
      const state = await context.backend.product.state();
      invariant(
        !query.version || query.version === state.version,
        "VERSION_CONFLICT",
        "Состав изменился. Начните list без --cursor.",
      );
      const scope = state.records.find(
        (record) =>
          record.fields.kind === "scope" && record.fields.applicationId === application.ref.id,
      );
      const contracts = scope?.fields.kind === "scope" ? scope.fields.contracts : [];
      const next = query.offset + query.limit;
      const data = {
        application: application.ref,
        revision: scope?.revision ?? 0,
        version: state.version,
        items: contracts.slice(query.offset, next),
        total: contracts.length,
        nextOffset: next < contracts.length ? next : null,
      };
      return {
        data,
        page: pageResult(context, command, filters, query, data),
        text: (options) =>
          listText(
            {
              title: `Состав ${application.key} — ${application.title}`,
              filters: [
                ["Ревизия состава", data.revision],
                ["Версия для записи", data.version, "opaque"],
              ],
              items: data.items.map((item) => {
                const target = state.records.find(
                  (record) => record.id === (item.scenarioId ?? item.featureId),
                );
                const fields = target?.fields;
                const title =
                  fields && "name" in fields ? fields.name : "Название не предоставлено";
                return {
                  key: item.key ?? item.id,
                  title: item.title,
                  details: [
                    item.active ? "Участвует" : "Участие снято",
                    ...(item.active
                      ? [`Вычисляемая готовность: ${stateLabel("implementation", item.status)}`]
                      : []),
                    `Цель: ${target?.key ?? item.scenarioId ?? item.featureId} — ${title}`,
                  ],
                };
              }),
              emptyMessage:
                data.total === 0
                  ? "Реализаций нет. Новые вклады создаются через implementation create."
                  : "На этой странице реализаций нет.",
              commands: [
                ...(data.items[0]
                  ? [
                      {
                        label: "Прочитать первый вклад; для другого замените ключ",
                        command: commandInvocation(context, [
                          "implementation",
                          "get",
                          data.items[0].key ?? `implementation:${data.items[0].id}`,
                        ]),
                      },
                    ]
                  : []),
                {
                  label: "Компактная страница состава с адресами целей и сохранёнными отметками",
                  command: commandInvocation(context, [
                    "application",
                    "participation",
                    "list",
                    application.key,
                    "--projection",
                    "compact",
                  ]),
                },
                {
                  label: "Правила атомарной замены полного состава",
                  command: commandInvocation(context, [
                    "application",
                    "participation",
                    "replace",
                    "--help",
                  ]),
                },
              ],
            },
            options,
          ),
      };
    },
  });
  registerCommand<{
    ifRevision: number;
    ifVersion: string;
    requestId?: string;
    implementations?: string[];
    clear?: boolean;
    composition?: string;
    compositionFile?: string;
  }>(group, runtime, {
    name: "replace <ref>",
    arguments: { ref: "Ключ или ID приложения" },
    description: "Заменить выбранный активный состав",
    details:
      'Выберите один источник полного активного состава: --implementations, --clear либо --composition/--composition-file. JSON composition: [{"kind":"existing","ref":"WEB-FI-1"},{"kind":"target","target":"SCENARIO-1","title":"Вклад Web","description":"Markdown","status":"none"}]. existing сохраняет адрес, тексты и ручную отметку; target создаёт только новую пару приложение/цель. [] снимает всё участие. Новый FI и SI сохраняются одной операцией, SI требует FI. Непереданные в наборе реализации снимаются, не удаляются. Ревизия состава и version — из participation list; snapshotVersion не используйте для записи. Скрытого повтора нет. Квитанция composition также перечисляет созданные реализации.',
    examples: [
      [
        "npx @oim-dev/relay-cli application participation replace WEB --implementations WEB-FI-1 WEB-SI-1 --if-revision 2 --if-version VERSION --actor agent",
        "Выбрать полный состав по прочитанной версии",
      ],
      [
        "npx @oim-dev/relay-cli application participation replace WEB --composition-file ./composition.json --if-revision 0 --if-version VERSION --actor agent",
        "Атомарно выбрать новые FI/SI и существующие вклады; подготовьте JSON и замените исходные guards прочитанными",
      ],
    ],
    configure: (command) => {
      textOption(
        command,
        "composition",
        "Полный активный состав JSON: existing/ref либо target/target/title/description/status; один stdin",
      );
      return revisionOption(command)
        .requiredOption("--if-version <version>", "Прочитанная версия продукта")
        .option("--implementations <refs...>", "Полный активный набор существующих реализаций")
        .option("--clear", "Снять всё участие, сохранив реализации");
    },
    async run(context, input) {
      const options = input.options;
      const hasComposition =
        options.composition !== undefined || options.compositionFile !== undefined;
      invariant(
        Number(options.implementations !== undefined) +
          Number(Boolean(options.clear)) +
          Number(hasComposition) ===
          1,
        "INVALID_ARGUMENT",
        "Выберите --implementations, --clear либо --composition/--composition-file",
      );
      invariant(
        !options.implementations ||
          new Set(options.implementations).size === options.implementations.length,
        "INVALID_ARGUMENT",
        "Адрес реализации указан в --implementations повторно",
      );
      const { composition } = await readTextFields(context, options, ["composition"]);
      let selections: unknown = (options.implementations ?? []).map((ref) => ({
        kind: "existing",
        ref,
      }));
      if (composition !== undefined) {
        try {
          selections = JSON.parse(composition);
        } catch {
          throw new AppError(
            "INVALID_JSON",
            "--composition / --composition-file должен содержать JSON-массив полного состава",
          );
        }
      }
      const command = parse(
        productParticipationReplaceSchema,
        {
          application: input.argument(),
          selections,
          ifRevision: options.ifRevision,
          ifVersion: options.ifVersion,
          requestId: options.requestId ?? randomUUID(),
        },
        "полный состав приложения",
      );
      const saved = await context.backend.product.replaceParticipation(command, author(context));
      // Прежние варианты ввода сохраняют прежнюю квитанцию; новый composition — явный opt-in.
      const data = hasComposition
        ? { ...saved, requestId: command.requestId }
        : {
            id: saved.scopeId,
            ...("key" in saved && typeof saved.key === "string" ? { key: saved.key } : {}),
            revision: saved.revision,
            requestId: command.requestId,
          };
      return {
        data,
        text: (textOptions) => participationSavedText(saved, textOptions, context),
      };
    },
  });
}
