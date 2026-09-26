import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { productMutationSchema } from "@relay/core/domain/product";
import { parse } from "@relay/core/domain/validation";
import { invariant, AppError } from "@relay/core/shared/errors";
import { author } from "../context.js";
import type { Runtime } from "../context.js";
import { commandGroup, registerCommand } from "../command.js";
import { integer } from "../options.js";
import { lintProduct } from "@relay/core/application/product/content";
import type { ProductContentQuery } from "@relay/core/application/product/content";
import { ProductRepository } from "@relay/core/storage/product";
import { validateProduct } from "@relay/core/application/product/model";
import {
  productContextText,
  productListText,
  productOverviewText,
  productRecordText,
  productSavedText,
  productStateText,
  productLintText,
} from "../presentation/product.js";
import type { ProductMutation } from "@relay/core/domain/product";
import type { CommandContext } from "../context.js";
import type { Result } from "../queries/result.js";
import { updateImplementationSchema } from "@relay/core/domain/product-implementation";
import type {
  ProductEntitiesQuery,
  UpdateImplementation,
} from "@relay/core/domain/product-implementation";
import { productEntitiesText } from "../presentation/product.js";

async function save(context: CommandContext, command: ProductMutation): Promise<Result> {
  const data = {
    ...(await context.backend.product.mutate(command, author(context))),
    requestId: command.requestId,
  };
  return { data, text: (options) => productSavedText(command, data, options) };
}

/** Продуктовые операции с прямым многострочным Markdown и JSON-вводом. */
export function registerProduct(program: Command, runtime: Runtime): void {
  const group = commandGroup(program, {
    name: "product",
    description: "Паспорт, фичи, реализации и документы продукта",
    details:
      "Продукт независим от задач. Markdown передаётся непосредственно текстом. Все изменения требуют автора; обновления — прочитанной ревизии.",
    examples: [["relay-cli product overview", "Познакомиться с продуктом"]],
  });
  for (const name of ["state", "overview"] as const)
    registerCommand(group, runtime, {
      name,
      description: name === "state" ? "Полный снимок продукта" : "Компактная карта продукта",
      details: "Общая готовность вычисляется по контрактам всех проектов.",
      examples: [[`relay-cli product ${name}`, "Прочитать продукт"]],
      run: async (context) => {
        if (name === "state") {
          const data = await context.backend.product.state();
          return { data, text: (options) => productStateText(data, options) };
        }
        const data = await context.backend.product.overview();
        return { data, text: (options) => productOverviewText(data, options) };
      },
    });
  registerCommand<{
    kind?: "passport" | "feature" | "scenario" | "application" | "scope" | "document";
    q?: string;
    offset?: number;
    limit?: number;
  }>(group, runtime, {
    name: "list",
    description: "Найти записи продукта",
    details: "Возвращает страницу записей и nextOffset. Поиск включает Markdown.",
    examples: [["relay-cli product list --kind feature", "Найти фичи"]],
    configure: (command) =>
      command
        .option("--kind <kind>", "Вид записи")
        .option("--q <text>", "Поиск")
        .option("--offset <n>", "Смещение", integer(0, Number.MAX_SAFE_INTEGER))
        .option("--limit <n>", "Размер страницы", integer(1, 100)),
    run: async (context, input) => {
      const data = await context.backend.product.list(input.options);
      return { data, text: (options) => productListText(data, input.options, options) };
    },
  });
  registerCommand(group, runtime, {
    name: "get <id>",
    description: "Прочитать одну запись",
    arguments: { id: "ID или ключ записи, включая реализацию: WEB-FI-12" },
    details: "Ревизия из ответа используется при изменении.",
    examples: [["relay-cli product get passport", "Прочитать паспорт"]],
    run: async (context, input) => {
      const record = await context.backend.product.entity(input.argument());
      return { data: record, text: (options) => productRecordText(record, options) };
    },
  });
  registerCommand<ProductEntitiesQuery>(group, runtime, {
    name: "entities",
    description: "Найти цели для связи по ключу или названию",
    details: "Краткие сведения без полных описаний; ограниченная страница и продолжение.",
    examples: [["relay-cli product entities --q WEB-FI", "Найти реализации фич"]],
    configure: (command) =>
      command
        .option("--q <text>", "Ключ или название")
        .option(
          "--kind <kind>",
          "Тип цели: feature, scenario, application, implementation, passport, document",
        )
        .option("--application <ref>", "ID или ключ приложения")
        .option("--active <value>", "Участие: true или false")
        .option("--offset <n>", "Смещение", integer(0, Number.MAX_SAFE_INTEGER))
        .option("--limit <n>", "Размер страницы", integer(1, 100)),
    run: async (context, input) => {
      const data = await context.backend.product.entities(input.options);
      return { data, text: (options) => productEntitiesText(data, input.options, options) };
    },
  });
  const implementation = commandGroup(group, {
    name: "implementation",
    description: "Самостоятельная реализация фичи или сценария",
    details: "Правка по собственной ревизии; соседние реализации не изменяются.",
    examples: [["relay-cli product get WEB-FI-12", "Прочитать реализацию"]],
  });
  registerCommand<Omit<UpdateImplementation, "ref" | "requestId"> & { requestId?: string }>(
    implementation,
    runtime,
    {
      name: "update <ref>",
      description: "Изменить реализацию или разрешить конфликт ключа",
      arguments: { ref: "ID или ключ реализации" },
      details:
        "Передайте прочитанную ревизию. done подтверждает актуальные требования. После потери ответа перечитайте состояние; request-id не предотвращает повторную запись.",
      examples: [
        [
          "relay-cli product implementation update WEB-FI-12 --if-revision 1 --status partial --actor agent",
          "Обновить готовность",
        ],
      ],
      configure: (command) =>
        command
          .requiredOption(
            "--if-revision <n>",
            "Ревизия реализации",
            integer(1, Number.MAX_SAFE_INTEGER),
          )
          .option("--title <text>", "Однострочный заголовок")
          .option("--description <markdown>", "Полное описание Markdown")
          .option("--status <status>", "none, partial или done")
          .option("--key <key>", "Свободный ключ; ID и связи сохраняются")
          .option("--request-id <id>", "Идентификатор корреляции, не дедупликации"),
      run: async (context, input) => {
        const command = updateImplementationSchema.parse({
          ...input.options,
          ref: input.argument(),
          requestId: input.options.requestId ?? randomUUID(),
        });
        const result = await context.backend.product.updateImplementation(command, author(context));
        return {
          data: { ...result, requestId: command.requestId },
          text: `Реализация сохранена: ${result.key ?? result.id}\nID: ${result.id}\nРевизия: ${result.revision}\nИдентификатор запроса: ${command.requestId}`,
        };
      },
    },
  );
  registerCommand<{ id?: string; application?: string }>(group, runtime, {
    name: "context",
    description: "Собрать связанный контекст",
    details: "Паспорт, исходные контракты, реализации и документы с причинами включения.",
    examples: [["relay-cli product context --id scenario_<id>", "Контекст сценария"]],
    configure: (command) =>
      command
        .option("--id <id>", "Цель контекста")
        .option("--application <id>", "Проект-реализатор"),
    run: async (context, input) => {
      const data = await context.backend.product.context({
        id: input.options.id,
        applicationId: input.options.application,
      });
      return { data, text: (options) => productContextText(data, options) };
    },
  });
  registerCommand(group, runtime, {
    name: "validate",
    description: "Проверить целостность продукта",
    details: "Проверяет схемы JSON, принадлежность, контракты и ссылки.",
    examples: [["relay-cli product validate", "Проверить продукт"]],
    run: async (context) => {
      const state = await context.backend.product.state();
      return {
        data: { valid: true, records: state.records.length, version: state.version },
        text: `Продукт корректен. Проверено записей: ${state.records.length}.`,
      };
    },
  });
  registerCommand<ProductContentQuery>(group, runtime, {
    name: "lint",
    description: "Проверить структуру продуктовых описаний",
    details:
      "Предупреждения о Markdown и критериях не изменяют записи и не доказывают полноту требований.",
    examples: [["relay-cli product lint", "Найти описания, требующие внимания"]],
    configure: (command) =>
      command
        .option("--id <id>", "Проверить отдельную запись")
        .option("--offset <n>", "Смещение предупреждений", integer(0, Number.MAX_SAFE_INTEGER))
        .option("--limit <n>", "Число предупреждений на странице", integer(1, 100)),
    run: async (context, input) => {
      const data = lintProduct(await context.backend.product.state(), input.options);
      return { data, text: (options) => productLintText(data, options, input.options) };
    },
  });
  registerCommand(group, runtime, {
    name: "migrate",
    description: "Перенести продукт в каталоги и многострочный JSON",
    details:
      "Только локальный режим: --local --config <проект/.relay/config.json>. Перед запуском остановите старые клиенты и сохраните копию product. Возобновляемый перенос сохраняет содержание, ID и ревизии, но не историю и результаты запросов. Серверный конфиг workspace не подходит.",
    examples: [
      [
        "relay-cli --local --config .relay/config.json product migrate",
        "Обновить дисковый формат продукта",
      ],
    ],
    run: async (context) => {
      const workspace = context.backend.localWorkspace;
      invariant(workspace, "LOCAL_ONLY", "Миграция требует --local и конфиг отдельного проекта.");
      const migrated = await workspace.locked(async (assertOwned) => {
        const repository = new ProductRepository(workspace);
        validateProduct(await repository.all());
        return repository.migrate(assertOwned);
      });
      return {
        data: { migrated },
        text: `Миграция завершена. Перенесено записей: ${migrated}. Содержание и ревизии сохранены.`,
      };
    },
  });
  registerCommand<{ json?: string; description?: string; body?: string }>(group, runtime, {
    name: "save",
    description: "Создать или изменить запись через JSON",
    details:
      "JSON содержит action, fields, id/ifRevision для update, ifVersion для scope и requestId. --description и --body заменяют соответствующее поле прямым многострочным текстом.",
    examples: [
      [
        `relay-cli product save --json '{"action":"create","fields":{"kind":"feature","name":"Каталог","summary":"Поиск товаров","description":"## Поведение\\n\\nОписание"}}' --actor agent`,
        "Создать фичу",
      ],
    ],
    configure: (command) =>
      command
        .requiredOption("--json <json>", "JSON операции")
        .option("--description <markdown>", "Многострочный Markdown напрямую")
        .option("--body <markdown>", "Многострочный текст документа напрямую"),
    run: async (context, input) => {
      let value: unknown;
      try {
        value = JSON.parse(input.options.json ?? "");
      } catch {
        throw new AppError("INVALID_ARGUMENT", "Некорректный JSON", 2);
      }
      invariant(
        value &&
          typeof value === "object" &&
          "fields" in value &&
          value.fields &&
          typeof value.fields === "object",
        "INVALID_ARGUMENT",
        "Нужен объект fields",
      );
      const fields = {
        ...value.fields,
        ...(input.options.description === undefined
          ? {}
          : { description: input.options.description }),
        ...(input.options.body === undefined ? {} : { body: input.options.body }),
      };
      const command = parse(
        productMutationSchema,
        { requestId: randomUUID(), ...value, fields },
        "изменение продукта",
      );
      return save(context, command);
    },
  });
  for (const kind of ["passport", "feature", "scenario", "application", "document"] as const) {
    const entity = commandGroup(group, {
      name: kind,
      description: {
        passport: "Паспорт продукта",
        feature: "Фичи продукта",
        scenario: "Сценарии продукта",
        application: "Приложения продукта",
        document: "Документы продукта",
      }[kind],
      details: "Прямой ввод текстов без промежуточных файлов.",
      examples: [[`relay-cli product ${kind} create --help`, "Параметры создания"]],
    });
    for (const action of ["create", "update"] as const)
      registerCommand<{
        name: string;
        summary: string;
        description?: string;
        body?: string;
        type: string;
        slug?: string;
        prefix?: string;
        feature?: string;
        links: string;
        documentKind: string;
        ifRevision?: number;
        requestId?: string;
      }>(entity, runtime, {
        name: action === "create" ? action : "update <id>",
        description: action === "create" ? "Создать запись" : "Изменить запись",
        ...(action === "update" ? { arguments: { id: "Постоянный ID" } } : {}),
        details:
          "Передавайте полное содержание записи. Общие статусы фич и сценариев вычисляются автоматически.",
        examples: [[`relay-cli product ${kind} ${action} --help`, "Показать параметры"]],
        configure: (command) => {
          if (kind === "application")
            command
              .option(
                "--prefix <prefix>",
                "Неизменяемый префикс задач: WEB, API; по умолчанию из slug",
              )
              .requiredOption(
                "--slug <slug>",
                "Неизменяемый адрес приложения и доски: латинские строчные буквы, цифры и дефисы",
              );
          return command
            .requiredOption("--name <name>", "Название")
            .option("--summary <text>", "Краткое описание", "")
            .option(
              "--description <markdown>",
              "Markdown: цель, правила, шаги, ошибки и критерии по смыслу",
            )
            .option("--body <markdown>", "Структурированный Markdown документа напрямую")
            .option("--type <type>", "Тип приложения: frontend/backend/internal", "frontend")
            .option("--feature <id>", "Родительская фича сценария")
            .option("--links <json>", "Типизированные связи документа", "[]")
            .option(
              "--document-kind <kind>",
              "Назначение документа: specification/description/rules/decision",
              "description",
            )
            .option("--if-revision <n>", "Прочитанная ревизия", integer(0, Number.MAX_SAFE_INTEGER))
            .option("--request-id <id>", "Идентификатор корреляции, не дедупликации");
        },
        run: async (context, input) => {
          const options = input.options;
          let links: unknown;
          try {
            links = JSON.parse(options.links);
          } catch {
            throw new AppError("INVALID_ARGUMENT", "Некорректный JSON связей", 2);
          }
          const fields =
            kind === "document"
              ? {
                  kind,
                  name: options.name,
                  summary: options.summary,
                  body: options.body,
                  documentKind: options.documentKind,
                  links,
                }
              : kind === "scenario"
                ? {
                    kind,
                    name: options.name,
                    featureId: options.feature,
                    description: options.description,
                  }
                : {
                    kind,
                    name: options.name,
                    summary: options.summary,
                    description: options.description,
                    ...(kind === "application"
                      ? { type: options.type, slug: options.slug, prefix: options.prefix }
                      : {}),
                  };
          const command = parse(
            productMutationSchema,
            {
              action,
              ...(action === "update" ? { id: input.argument() } : {}),
              ifRevision: options.ifRevision,
              requestId: options.requestId ?? randomUUID(),
              fields,
            },
            "изменение продукта",
          );
          return save(context, command);
        },
      });
  }
  const scopeGroup = commandGroup(group, {
    name: "scope",
    description: "Состав реализации приложения",
    details:
      "Один состав сохраняется атомарно. Версия каталога берётся из product overview, ревизия состава — из product get.",
    examples: [["relay-cli product scope replace --help", "Параметры состава"]],
  });
  registerCommand<{ json: string; ifRevision: number; ifVersion: string; requestId?: string }>(
    scopeGroup,
    runtime,
    {
      name: "replace <applicationId>",
      description: "Заменить весь активный состав",
      arguments: { applicationId: "ID или ключ приложения" },
      details:
        "--json содержит массив контрактов: featureId, scenarioId (или null), title, description, status. Пустой массив снимает участие, сохраняя историю ссылок.",
      examples: [
        [
          "relay-cli product scope replace application_<id> --json '[]' --if-revision 1 --if-version <version> --actor agent",
          "Снять участие",
        ],
      ],
      configure: (command) =>
        command
          .requiredOption("--json <json>", "Массив контрактов JSON")
          .requiredOption(
            "--if-revision <n>",
            "Ревизия состава; 0 для нового",
            integer(0, Number.MAX_SAFE_INTEGER),
          )
          .requiredOption("--if-version <version>", "Версия прочитанного продукта")
          .option("--request-id <id>", "Идентификатор корреляции, не дедупликации"),
      run: async (context, input) => {
        let contracts: unknown;
        try {
          contracts = JSON.parse(input.options.json);
        } catch {
          throw new AppError("INVALID_ARGUMENT", "Некорректный JSON контрактов", 2);
        }
        const applicationId = input.argument();
        const command = parse(
          productMutationSchema,
          {
            action: input.options.ifRevision === 0 ? "create" : "update",
            ifRevision: input.options.ifRevision,
            ifVersion: input.options.ifVersion,
            requestId: input.options.requestId ?? randomUUID(),
            fields: { kind: "scope", applicationId, contracts },
          },
          "состав реализации",
        );
        return save(context, command);
      },
    },
  );
  const contractGroup = commandGroup(group, {
    name: "contract",
    description: "Обязательство одного приложения",
    details: "Точечное изменение не заменяет остальные контракты.",
    examples: [["relay-cli product contract update --help", "Параметры реализации"]],
  });
  registerCommand<{
    application: string;
    status: string;
    title?: string;
    description?: string;
    ifRevision: number;
    ifVersion: string;
    requestId?: string;
  }>(contractGroup, runtime, {
    name: "update <id>",
    description: "Изменить или подтвердить контракт",
    arguments: { id: "ID контракта" },
    details:
      "done подтверждает актуальные общие требования и описание реализации. Остальные контракты не переподтверждаются.",
    examples: [
      [
        "relay-cli product contract update contract_<id> --application application_<id> --status done --if-revision 1 --if-version <version> --actor agent",
        "Подтвердить реализацию",
      ],
    ],
    configure: (command) =>
      command
        .requiredOption("--application <id>", "Приложение")
        .requiredOption("--status <status>", "Готовность реализации: none/partial/done")
        .option("--title <text>", "Заголовок вклада")
        .option("--description <markdown>", "Многострочное описание напрямую")
        .requiredOption("--if-revision <n>", "Ревизия состава", integer(1, Number.MAX_SAFE_INTEGER))
        .requiredOption("--if-version <version>", "Версия прочитанного продукта")
        .option("--request-id <id>", "Идентификатор корреляции, не дедупликации"),
    run: async (context, input) => {
      const options = input.options;
      const command = parse(
        productMutationSchema,
        {
          action: "update",
          ifRevision: options.ifRevision,
          ifVersion: options.ifVersion,
          requestId: options.requestId ?? randomUUID(),
          fields: {
            kind: "contract",
            applicationId: options.application,
            contractId: input.argument(),
            status: options.status,
            title: options.title,
            description: options.description,
          },
        },
        "контракт реализации",
      );
      return save(context, command);
    },
  });
}
