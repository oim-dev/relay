import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { productMutationSchema } from "@relay/core/domain/product";
import { parse } from "@relay/core/domain/validation";
import { invariant } from "@relay/core/shared/errors";
import { commandGroup, registerCommand } from "../command.js";
import { author } from "../context.js";
import type { Runtime } from "../context.js";
import { paging, offsetQuery, pageResult, commandInvocation } from "../command-kit.js";
import { revisionOption, subject } from "./product.js";
import { listText, receiptText } from "../presentation/common.js";
import { stateLabel } from "../presentation/entities.js";

/** Выбор существующих реализаций адаптируется к атомарной замене состава Core. */
export function registerParticipation(parent: Command, runtime: Runtime) {
  const group = commandGroup(parent, {
    name: "participation",
    description: "Активный состав приложения",
    details:
      "Новые реализации создаются через implementation create. Снятые реализации сохраняют адреса и содержание; повторный выбор возвращает участие.",
    examples: [
      [
        "npx @oim-dev/relay-cli application participation list WEB",
        "Прочитать состав и условия записи",
      ],
    ],
  });
  registerCommand<{ cursor?: string; limit?: number }>(group, runtime, {
    name: "list <ref>",
    arguments: { ref: "Ключ или ID приложения" },
    description: "Прочитать участие и ревизию состава",
    details:
      "Включает снятые реализации. Для replace нужны ревизия состава и версия из этого ответа.",
    examples: [["npx @oim-dev/relay-cli application participation list WEB", "Прочитать состав"]],
    configure: paging,
    async run(context, input) {
      const application = await subject(context, "application", input.argument());
      const command = ["application", "participation", "list", input.argument()];
      const query = offsetQuery(context, input.options, command, {});
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
        page: pageResult(context, command, {}, query, data),
        text: (options) =>
          listText(
            {
              title: `Состав ${application.key} — ${application.title}`,
              filters: [
                ["Ревизия состава", data.revision],
                ["Версия для записи", data.version],
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
  }>(group, runtime, {
    name: "replace <ref>",
    arguments: { ref: "Ключ или ID приложения" },
    description: "Заменить выбранный активный состав",
    details:
      "Явно перечислите ВСЕ сохраняемые активные реализации через --implementations либо --clear. Сохранённые тексты и ручные отметки читаются из исходного состава, не из вычисленной готовности. SI требует FI; Core проверяет состав атомарно. Ревизия и версия — из participation list, не подставляются автоматически.",
    examples: [
      [
        "npx @oim-dev/relay-cli application participation replace WEB --implementations WEB-FI-1 WEB-SI-1 --if-revision 2 --if-version VERSION --actor agent",
        "Выбрать полный состав по прочитанной версии",
      ],
    ],
    configure: (command) =>
      revisionOption(command)
        .requiredOption("--if-version <version>", "Прочитанная версия продукта")
        .option("--implementations <refs...>", "Полный активный набор существующих реализаций")
        .option("--clear", "Снять всё участие, сохранив реализации"),
    async run(context, input) {
      const options = input.options;
      invariant(
        (options.implementations !== undefined) !== Boolean(options.clear),
        "INVALID_ARGUMENT",
        "Выберите --implementations или --clear",
      );
      const application = await subject(context, "application", input.argument());
      const state = await context.backend.product.state();
      invariant(
        state.version === options.ifVersion,
        "VERSION_CONFLICT",
        "Продукт изменился. Перечитайте participation list и согласуйте состав.",
        4,
      );
      const scope = state.records.find(
        (record) =>
          record.fields.kind === "scope" && record.fields.applicationId === application.ref.id,
      );
      invariant(
        (scope?.revision ?? 0) === options.ifRevision,
        "REVISION_CONFLICT",
        "Ревизия состава изменилась. Перечитайте participation list.",
        4,
      );
      // Только чтение по голому ID состава возвращает persisted contracts.
      // state и адресные чтения реализации содержат вычисленную готовность.
      const raw = scope ? await context.backend.product.entity(scope.id) : undefined;
      invariant(
        !raw || (raw.fields.kind === "scope" && raw.fields.applicationId === application.ref.id),
        "INVALID_DATA",
        "Backend вернул не исходный состав выбранного приложения",
        5,
      );
      invariant(
        !raw || raw.revision === options.ifRevision,
        "REVISION_CONFLICT",
        "Ревизия состава изменилась между чтениями. Перечитайте participation list.",
        4,
      );
      const contracts = raw?.fields.kind === "scope" ? raw.fields.contracts : [];
      const selected = [];
      const ids = new Set<string>();
      for (const ref of options.implementations ?? []) {
        const implementation = await context.backend.entities.resolve({
          ref,
          kind: "implementation",
        });
        const contract = contracts.find((entry) => entry.id === implementation.ref.id);
        invariant(contract, "INVALID_ARGUMENT", "Выбранная реализация не входит в это приложение");
        invariant(
          !ids.has(contract.id),
          "INVALID_ARGUMENT",
          "Реализация указана в составе повторно",
        );
        ids.add(contract.id);
        selected.push({
          featureId: contract.featureId,
          scenarioId: contract.scenarioId,
          title: contract.title,
          description: contract.description,
          status: contract.status,
          ...(contract.key === undefined ? {} : { key: contract.key }),
          ...(contract.revision === undefined ? {} : { revision: contract.revision }),
        });
      }
      // Исходная версия включает индивидуальные ревизии и защищает также окно
      // между raw-чтением, разрешением адресов и единственной записью состава.
      const command = parse(
        productMutationSchema,
        {
          action: scope ? "update" : "create",
          ifRevision: options.ifRevision,
          ifVersion: options.ifVersion,
          requestId: options.requestId ?? randomUUID(),
          fields: { kind: "scope", applicationId: application.ref.id, contracts: selected },
        },
        "состав приложения",
      );
      const data = {
        ...(await context.backend.product.mutate(command, author(context))),
        requestId: command.requestId,
      };
      return {
        data,
        text: (options) =>
          receiptText(
            {
              title: `Активный состав заменён: ${application.key}`,
              fields: [
                ["Приложение", application.title],
                ["Ревизия состава", data.revision],
                ["Выбрано реализаций", selected.length],
              ],
              commands: [
                {
                  label: "Перечитать состав и версию",
                  command: commandInvocation(context, [
                    "application",
                    "participation",
                    "list",
                    application.key,
                  ]),
                },
              ],
            },
            options,
          ),
      };
    },
  });
}
