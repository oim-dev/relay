import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { entityCreateSchema, entityUpdateSchema } from "@relay/contracts/entities";
import type { EntitiesQuery, EntityDetail } from "@relay/contracts/entities";
import { parse } from "@relay/core/domain/validation";
import { AppError, invariant } from "@relay/core/shared/errors";
import { commandGroup, registerCommand } from "../command.js";
import { author } from "../context.js";
import type { CommandContext, Runtime } from "../context.js";
import { integer } from "../options.js";
import {
  textOption,
  readTextFields,
  paging,
  offsetQuery,
  pageResult,
  commandInvocation,
} from "../command-kit.js";
import {
  entitiesText,
  entityText,
  entitySavedText,
  entityReadArgs,
} from "../presentation/entities.js";
import { registerEntityProgress } from "./progress.js";
import { registerDocumentRelations, registerDocumentSections } from "./product-documents.js";
import { registerParticipation } from "./product-participation.js";
import { registerEntityDeletion } from "./entity-deletion.js";
import { registerProductReading } from "./product-queries.js";

type Kind = "product" | "feature" | "scenario" | "application" | "implementation" | "document";
type Options = Record<string, unknown> & {
  ifRevision?: number;
  requestId?: string;
  limit?: number;
  cursor?: string;
};
const titles: Record<Kind, string> = {
  product: "Паспорт продукта",
  feature: "Фичи продукта",
  scenario: "Сценарии фич",
  application: "Приложения",
  implementation: "Реализации требований",
  document: "Библиотека документов",
};
const examples: Record<Kind, string> = {
  product: "",
  feature: "FEATURE-1",
  scenario: "SCENARIO-1",
  application: "WEB",
  implementation: "WEB-FI-1",
  document: "DOC-1",
};
const contentHints: Record<Kind, string> = {
  product: "Назначение продукта, пользователи, цели, границы и ограничения",
  feature:
    "Для кого и зачем возможность, требуемое поведение, правила, границы и проверяемые результаты",
  scenario: "Участник, предусловия, шаги, альтернативы, ошибки и наблюдаемый результат",
  application: "Ответственность приложения, границы, взаимодействия и ограничения",
  implementation:
    "Требования к вкладу именно этого приложения: поведение, входы/выходы, взаимодействия, ошибки и проверка",
  document: "Содержание по типу документа, основания, правила или выводы и открытые вопросы",
};
const contentExamples: Record<Kind, { title: string; body: string }> = {
  product: {
    title: "Библиотека инструкций",
    body: "## Назначение\n\nПомочь сотруднику найти действующую инструкцию по названию.\n\n## Границы\n\nХраним инструкции и предоставляем поиск. Согласование документов не входит в первый выпуск.\n\n## Результат\n\nСотрудник открывает полный текст выбранной инструкции из результатов поиска.",
  },
  feature: {
    title: "Поиск инструкций",
    body: "## Цель\n\nСотрудник находит действующую инструкцию по части названия.\n\n## Правила\n\n- Поиск не учитывает регистр и краевые пробелы.\n- Архивные документы не попадают в результаты.\n\n## Результат и ошибки\n\nРезультаты ведут к полному тексту. При отсутствии совпадений показывается пустое состояние; ошибка чтения не выдаётся за отсутствие документов.",
  },
  scenario: {
    title: "Найти инструкцию по названию",
    body: "## Участник и условия\n\nСотрудник открыл библиотеку. Правила поиска заданы в связанной фиче.\n\n## Основной путь\n\n1. Вводит часть названия.\n2. Отправляет поисковый запрос.\n3. Открывает полный текст выбранной инструкции.\n\n## Отклонения\n\nПри отсутствии совпадений видит пустое состояние. При ошибке чтения запрос сохраняется и доступен повтор.\n\n## Результат\n\nОткрыта выбранная инструкция без потери поискового запроса.",
  },
  application: {
    title: "Web библиотеки",
    body: "## Ответственность\n\nПоказать каталог, поиск и полный текст инструкции сотруднику.\n\n## Взаимодействие\n\nПолучать данные через API библиотеки; хранение документов принадлежит серверу.\n\n## Ограничения\n\nПоказывать ожидание, пустой результат и ошибку чтения раздельно. Согласование документов не входит в приложение.",
  },
  implementation: {
    title: "Поиск инструкций в Web",
    body: "## Ответственность\n\nWeb реализует ввод запроса и показ результатов связанной фичи поиска; хранение и отбор документов принадлежат API.\n\n## Поведение и данные\n\nПередать введённый запрос в API. Показать названия найденных документов со ссылками на полный текст. Сохранять запрос при открытии результата.\n\n## Состояния и ошибки\n\nПоказывать ожидание отдельно от пустого результата. При ошибке API сохранить запрос, показать сообщение и действие повтора.\n\n## Проверка\n\nПроверить совпадения, пустой ответ и отказ API; после открытия документа запрос сохранён.",
  },
  document: {
    title: "Проверка поиска инструкций",
    body: "## Назначение\n\nПроверить результаты поиска и состояния Web по связанному требованию.\n\n## Подготовка\n\nСоздать действующую и архивную инструкции с одинаковым словом в названии.\n\n## Проверка\n\n1. Найти это слово: доступна только действующая инструкция.\n2. Открыть результат и сверить полный текст.\n3. Проверить отсутствие совпадений и отказ API раздельно.\n\n## Результат\n\nЗаписать фактические исходы; эта инструкция сама по себе не подтверждает прохождение проверки.",
  },
};
function writeExample(kind: Kind, action: "create" | "update") {
  const base = `npx @oim-dev/relay-cli ${kind} ${action}`;
  const name = kind === "implementation" ? "--title" : "--name";
  if (action === "update")
    return `${base}${examples[kind] ? ` ${examples[kind]}` : ""} --actor agent ${name} 'Уточнённое название' --if-revision 1`;
  const extra =
    kind === "scenario"
      ? " --feature FEATURE-1"
      : kind === "application"
        ? " --slug web"
        : kind === "implementation"
          ? " --application WEB --target FEATURE-1"
          : "";
  const example = contentExamples[kind];
  return `${base} --actor agent ${name} '${example.title}' --${kind === "document" ? "body" : "description"} '${example.body}'${extra}`;
}
const texts = (kind: Kind) =>
  kind === "document"
    ? ["summary", "body"]
    : kind === "scenario" || kind === "implementation"
      ? ["description"]
      : ["summary", "description"];
export const revisionOption = (command: Command) =>
  command
    .requiredOption(
      "--if-revision <n>",
      "Прочитанная ревизия; при конфликте перечитайте запись",
      integer(0, Number.MAX_SAFE_INTEGER),
    )
    .option("--request-id <id>", "Корреляция, не гарантия безопасного повтора");

export async function subject(
  context: CommandContext,
  kind: Kind,
  ref: string,
): Promise<EntityDetail> {
  return context.backend.entities.get({ kind, ref });
}

function fieldOptions(command: Command, kind: Kind, creating: boolean) {
  const title = kind === "implementation" ? "title" : "name";
  if (creating) command.requiredOption(`--${title} <text>`, "Однострочное название");
  else command.option(`--${title} <text>`, "Новое однострочное название");
  for (const field of texts(kind))
    textOption(
      command,
      field,
      field === "summary"
        ? "Краткая аннотация обычным текстом; не заменяет полное описание"
        : `Полное содержание в Markdown: ${contentHints[kind]}; не краткая аннотация`,
    );
  if (!creating && texts(kind).includes("summary"))
    command.option("--clear-summary", "Очистить краткое описание");
  if (kind === "scenario" && creating)
    command.requiredOption("--feature <ref>", "Родительская фича: ключ или ID");
  if (kind === "application") {
    command.option("--type <type>", "Тип: frontend/backend/internal");
    if (creating)
      command
        .requiredOption("--slug <slug>", "Неизменяемый адрес приложения")
        .option("--prefix <prefix>", "Неизменяемый префикс задач");
  }
  if (kind === "implementation") {
    if (creating)
      command
        .requiredOption("--application <ref>", "Приложение")
        .requiredOption("--target <ref>", "Фича или сценарий");
    command.option(
      "--status <status>",
      "Совместимая отметка none/partial/done; не меняет вычисляемую готовность",
    );
  }
  if (kind === "document") {
    textOption(
      command,
      "relations",
      'Полная замена адресных отношений: JSON-массив [{"target":{"kind":"feature","id":"ID"},"type":"documents","description":"Markdown"}]',
    );
    command
      .option(
        "--document-kind <kind>",
        "Назначение: specification/description/rules/instruction/proposal/decision/research",
      )
      .option("--document-status <state>", "Состояние: draft/active/archived")
      .option("--section-id <id>", "Раздел библиотеки")
      .option("--clear-section", "Оставить без раздела")
      .option("--pinned <value>", "Закрепление: true/false", (value) => {
        invariant(
          value === "true" || value === "false",
          "INVALID_ARGUMENT",
          "Укажите --pinned true или false",
        );
        return value === "true";
      })
      .option(
        "--targets <refs...>",
        "Заменить прежние продуктовые области; адресные связи — --relations или document link",
      )
      .option("--clear-targets", "Очистить прежние продуктовые области")
      .option("--clear-relations", "Очистить адресные отношения; прежние области сохраняются");
  }
  return creating
    ? command.option("--request-id <id>", "Корреляция, не безопасный повтор")
    : revisionOption(command);
}

async function readFields(
  context: CommandContext,
  options: Options,
  kind: Kind,
  creating: boolean,
) {
  invariant(
    !(
      options.clearRelations &&
      (options.relations !== undefined || options.relationsFile !== undefined)
    ),
    "CONFLICTING_OPTIONS",
    "Выберите --relations, --relations-file или --clear-relations",
  );
  // Все источники, включая JSON, проверяются вместе до чтения единственного stdin и записи.
  const { relations, ...text } = await readTextFields(context, options, [
    ...texts(kind),
    ...(kind === "document" ? ["relations"] : []),
  ]);
  invariant(
    !(options.clearSummary && text.summary !== undefined),
    "INVALID_ARGUMENT",
    "--clear-summary несовместим с источником --summary",
  );
  invariant(
    !(options.clearSection && options.sectionId !== undefined),
    "INVALID_ARGUMENT",
    "Выберите --section-id или --clear-section",
  );
  invariant(
    !(options.clearTargets && options.targets !== undefined),
    "INVALID_ARGUMENT",
    "Выберите --targets или --clear-targets",
  );
  const fields: Record<string, unknown> = { kind, ...text };
  if (relations !== undefined) {
    try {
      const parsed: unknown = JSON.parse(relations);
      // В CLI пояснение необязательно; Backend получает строку. Явные неверные значения
      // и остальные поля не исправляем: их проверяет общая предметная схема.
      fields.relations = Array.isArray(parsed)
        ? parsed.map((relation: unknown) =>
            typeof relation === "object" &&
            relation !== null &&
            !Array.isArray(relation) &&
            !Object.hasOwn(relation, "description")
              ? { ...relation, description: "" }
              : relation,
          )
        : parsed;
    } catch {
      throw new AppError(
        "INVALID_JSON",
        "--relations / --relations-file должен содержать корректный JSON-массив отношений",
      );
    }
  }
  for (const name of [
    "name",
    "title",
    "type",
    "slug",
    "prefix",
    "application",
    "target",
    "status",
    "documentKind",
    "documentStatus",
    "sectionId",
    "pinned",
    "targets",
  ])
    if (options[name] !== undefined) fields[name] = options[name];
  if (options.feature !== undefined) fields.featureId = options.feature;
  if (options.clearSummary) fields.summary = "";
  if (options.clearSection) fields.sectionId = null;
  if (options.clearTargets) fields.targets = [];
  if (options.clearRelations) fields.relations = [];
  if (creating) {
    if (texts(kind).includes("summary") && fields.summary === undefined) fields.summary = "";
    if (kind === "application" && fields.type === undefined) fields.type = "frontend";
    if (kind === "document" && fields.documentKind === undefined)
      fields.documentKind = "description";
  } else
    invariant(
      Object.keys(fields).length > 1,
      "INVALID_ARGUMENT",
      "Укажите хотя бы одно изменяемое поле; справка: <вид> update --help",
    );
  return fields;
}

/** Единственный предметный путь: паспорт — singleton, остальные виды — адресные группы. */
export function registerProduct(program: Command, runtime: Runtime): void {
  for (const kind of [
    "product",
    "feature",
    "scenario",
    "application",
    "implementation",
    "document",
  ] as const) {
    const singleton = kind === "product";
    const group = commandGroup(program, {
      name: kind,
      description: titles[kind],
      details:
        (kind === "document"
          ? "Содержание принимается текстом; полный набор адресных отношений — JSON-массивом --relations/--relations-file. "
          : "Обычный ввод без JSON. ") +
        "Изменение передаёт только указанные поля и требует прочитанной ревизии.",
      examples: [
        [`npx @oim-dev/relay-cli ${kind} ${singleton ? "get" : "list"}`, "Прочитать данные"],
      ],
    });
    if (!singleton)
      registerCommand<Omit<EntitiesQuery, "limit"> & { limit?: number; cursor?: string }>(
        group,
        runtime,
        {
          name: "list",
          description: "Найти записи",
          details: "Согласованный снимок; продолжение сохраняет фильтры. Полное содержание — get.",
          examples: [[`npx @oim-dev/relay-cli ${kind} list --limit 20`, "Прочитать страницу"]],
          configure(command) {
            paging(command)
              .option("--q <text>", "Поиск по адресам, названию, аннотации и полному содержанию")
              .option("--sort <field>", "Сортировка: key/title/updated");
            if (
              kind === "feature" ||
              kind === "scenario" ||
              kind === "implementation" ||
              kind === "document"
            )
              command.option(
                "--status <state>",
                kind === "document"
                  ? "Состояние: draft/active/archived"
                  : kind === "implementation"
                    ? "Вычисляемая готовность: none/partial/done; снятое участие: inactive"
                    : "Вычисляемая готовность: none/partial/done",
              );
            if (kind === "scenario" || kind === "implementation")
              command.option("--feature <ref>", "Родительская фича");
            if (kind === "implementation")
              command
                .option("--application <ref>", "Приложение")
                .option("--scenario <ref>", "Сценарий")
                .option("--implementation-target <kind>", "Вид цели: feature — FI, scenario — SI")
                .option("--target <ref>", "Цель реализации")
                .option("--active <value>", "Участие: true/false");
            if (kind === "document")
              command
                .option("--target <ref>", "Прикрепление к сущности")
                .option("--section <id>", "Раздел; none — без раздела")
                .option("--document-kind <kind>", "Тип документа")
                .option("--pinned <value>", "Закрепление: true/false")
                .option("--archived <value>", "Архив: true/false");
          },
          async run(context, input) {
            const { cursor: _cursor, limit: _limit, ...filters } = input.options;
            const command = [kind, "list"];
            const query = offsetQuery(context, input.options, command, filters);
            const data = await context.backend.entities.list({ ...filters, kind, ...query });
            return {
              data,
              page: pageResult(context, command, filters, query, data),
              text: (options) =>
                entitiesText(
                  data,
                  { ...filters, kind },
                  options,
                  data.items[0] ? [commandInvocation(context, entityReadArgs(data.items[0]))] : [],
                  "catalog",
                ),
            };
          },
        },
      );
    registerCommand(group, runtime, {
      name: singleton ? "get" : "get <ref>",
      ...(singleton ? {} : { arguments: { ref: "Ключ или ID записи" } }),
      description: "Прочитать полное содержание и ревизию",
      details: "Сохраните ревизию для следующего изменения. Незаполненный паспорт имеет ревизию 0.",
      examples: [
        [
          `npx @oim-dev/relay-cli ${kind} get${singleton ? "" : ` ${examples[kind]}`}`,
          "Прочитать запись",
        ],
      ],
      async run(context, input) {
        const data = await subject(
          context,
          kind,
          singleton ? "product:passport" : input.argument(),
        );
        const related = (targetKind: "feature" | "scenario" | "application", id: string) => {
          const record = data.references.find(
            (item) => item.ref.kind === targetKind && item.ref.id === id,
          );
          return commandInvocation(context, [
            targetKind,
            "get",
            record?.key ?? `${targetKind}:${id}`,
          ]);
        };
        const commands = {
          ...(kind === "document"
            ? { links: commandInvocation(context, ["document", "links", data.key]) }
            : {}),
          ...(kind === "feature"
            ? {
                scenarios: commandInvocation(context, ["scenario", "list", "--feature", data.key]),
                implementations: commandInvocation(context, [
                  "implementation",
                  "list",
                  "--feature",
                  data.key,
                ]),
              }
            : {}),
          ...(data.data.kind === "scenario"
            ? {
                feature: related("feature", data.data.featureId),
                implementations: commandInvocation(context, [
                  "implementation",
                  "list",
                  "--scenario",
                  data.key,
                ]),
              }
            : {}),
          ...(data.data.kind === "implementation"
            ? {
                target: data.data.scenarioId
                  ? related("scenario", data.data.scenarioId)
                  : related("feature", data.data.featureId),
                application: related("application", data.data.applicationId),
                participation: commandInvocation(context, [
                  "application",
                  "participation",
                  "list",
                  `application:${data.data.applicationId}`,
                  "--projection",
                  "compact",
                ]),
              }
            : {}),
          ...(data.data.kind === "application"
            ? {
                participation: commandInvocation(context, [
                  "application",
                  "participation",
                  "list",
                  data.key,
                  "--projection",
                  "compact",
                ]),
                tasks: commandInvocation(context, ["task", "list", "--board", data.data.slug]),
                productContext: commandInvocation(context, [
                  "product",
                  "context",
                  "--id",
                  data.key,
                ]),
              }
            : {}),
          ...(["feature", "scenario", "implementation", "application"].includes(kind)
            ? {
                progress: commandInvocation(context, [kind, "progress", data.key]),
                documents: commandInvocation(context, ["document", "list", "--target", data.key]),
              }
            : {}),
          ...(["feature", "scenario", "implementation"].includes(kind)
            ? { tasks: commandInvocation(context, ["task", "list", "--product-target", data.key]) }
            : {}),
          ...(kind === "product"
            ? {
                overview: commandInvocation(context, ["product", "overview"]),
                documents: commandInvocation(context, ["document", "list", "--target", data.key]),
              }
            : {}),
          context: commandInvocation(context, ["inspect", "graph", "context", data.key]),
          ...(!singleton
            ? { deletion: commandInvocation(context, [kind, "delete-preview", data.key]) }
            : {}),
        };
        return { data, text: (options) => entityText(data, options, commands) };
      },
    });
    for (const action of ["create", "update"] as const)
      registerCommand<Options>(group, runtime, {
        name: action === "create" || singleton ? action : "update <ref>",
        ...(action === "update" && !singleton ? { arguments: { ref: "Ключ или ID записи" } } : {}),
        description: action === "create" ? "Создать запись" : "Изменить только указанные поля",
        details:
          `Полное описание оформляйте разделами и списками в Markdown, достаточно подробно для исполнения и проверки без чата. ${contentHints[kind]}. Правила берите из требований; неизвестное уточняйте, не выдумывайте. Markdown принимается текстом, из файла или stdin. Источники одного поля несовместимы. После потери ответа сначала прочитайте запись; автоматического повтора нет.` +
          (kind === "implementation" && action === "create"
            ? " Для снятого участия той же пары приложение/цель Core возвращает прежний ID, но заменяет название, описание и совместимую отметку переданными значениями; без --status применяется none. Для возврата участия с сохранением содержания используйте application participation list/replace с прочитанными ревизией состава и версией продукта."
            : "") +
          (kind === "document"
            ? ' --relations <json> или --relations-file <path|-> атомарно сохраняет полный массив отношений вместе с текстом; [] очищает его. Элемент: {"target":{"kind":"feature","id":"постоянный ID"},"type":"documents","description":"Markdown"}; type — documents/references, description необязателен. ID узнайте через inspect resolve. Это замена, не добавление; непереданные relations и прежние targets сохраняются при update. --clear-relations несовместим с источником relations. Для всех полей вместе допустим один stdin.'
            : ""),
        examples: [
          [
            writeExample(kind, action),
            action === "create"
              ? "Учебный пример: замените требования и адреса данными своего проекта"
              : "Изменить название; замените ревизию прочитанным значением",
          ],
          ...(kind === "document"
            ? [
                [
                  `npx @oim-dev/relay-cli document ${action}${action === "update" ? " DOC-1 --if-revision 1" : " --name 'Решение'"} --actor agent --body-file ./decision.md --relations-file ./relations.json`,
                  "Атомарно сохранить содержание и полный набор отношений; подготовьте JSON с постоянными ID целей",
                ] as const,
              ]
            : []),
        ],
        configure: (command) => fieldOptions(command, kind, action === "create"),
        async run(context, input) {
          const fields = await readFields(context, input.options, kind, action === "create");
          const requestId = input.options.requestId ?? randomUUID();
          if (action === "create") {
            const command = parse(
              entityCreateSchema,
              { data: fields, requestId },
              "создание записи",
            );
            const data = await context.backend.entities.create(command, author(context));
            return {
              data,
              text: (options) =>
                entitySavedText(
                  data,
                  commandInvocation(context, [kind, "get", ...(singleton ? [] : [data.key])]),
                  options,
                ),
            };
          }
          const ref = singleton ? "product:passport" : input.argument();
          const command = parse(
            entityUpdateSchema,
            { ref, changes: fields, ifRevision: input.options.ifRevision, requestId },
            "изменение записи",
          );
          const data = await context.backend.entities.update(command, author(context));
          return {
            data,
            text: (options) =>
              entitySavedText(
                data,
                commandInvocation(context, [kind, "get", ...(singleton ? [] : [data.key])]),
                options,
              ),
          };
        },
      });
    registerCommand<{ ifRevision: number; requestId?: string }>(group, runtime, {
      name: singleton ? "rename <key>" : "rename <ref> <key>",
      arguments: singleton
        ? { key: "Новый читаемый ключ, не название" }
        : { ref: "Ключ или ID", key: "Новый читаемый ключ, не название" },
      description: "Изменить ключ с сохранением ID и алиасов",
      details: "Название меняется через update --name (у реализации --title).",
      examples: [[`npx @oim-dev/relay-cli ${kind} rename --help`, "Правила переименования"]],
      configure: revisionOption,
      async run(context, input) {
        const record = await subject(
          context,
          kind,
          singleton ? "product:passport" : input.argument(),
        );
        const data = await context.backend.entities.rename(
          {
            ref: `${kind}:${record.ref.id}`,
            key: input.argument(singleton ? 0 : 1),
            ifRevision: input.options.ifRevision,
            requestId: input.options.requestId ?? randomUUID(),
          },
          author(context),
        );
        return {
          data,
          text: (options) =>
            entitySavedText(
              data,
              commandInvocation(context, [kind, "get", ...(singleton ? [] : [data.key])]),
              options,
            ),
        };
      },
    });
    if (kind !== "document") registerEntityProgress(group, runtime, kind);
    if (kind === "feature" || kind === "scenario" || kind === "implementation") {
      const details = {
        feature:
          "Удаляются фича, её сценарии и реализации; приложения, задачи и документы сохраняются со снятием затронутых ссылок.",
        scenario:
          "Удаляются сценарий и его реализации; фича, задачи и документы сохраняются со снятием затронутых ссылок.",
        implementation:
          "Для FI удаляются также SI той же фичи и приложения; для SI — только выбранная реализация. Общие требования, задачи и документы сохраняются со снятием затронутых ссылок. Снятие участия не равно удалению.",
      };
      registerEntityDeletion(group, runtime, {
        kind,
        example: examples[kind],
        details: details[kind],
        catalogs: [
          { label: "Проверить оставшийся каталог (удаление не повторять)", args: [kind, "list"] },
          { label: "Проверить сохранённые задачи и снятые цели", args: ["task", "list"] },
          { label: "Проверить сохранённые документы и прикрепления", args: ["document", "list"] },
        ],
      });
    }
    if (kind === "document") {
      registerDocumentRelations(group, runtime);
      registerDocumentSections(group, runtime);
      registerEntityDeletion(group, runtime, {
        kind,
        example: examples[kind],
        details:
          "Удаляется только документ; прикреплённые сущности и другие документы сохраняются со снятием затронутых ссылок. Архивирование и открепление не равны удалению.",
        catalogs: [
          {
            label: "Проверить оставшиеся документы и их прикрепления (удаление не повторять)",
            args: ["document", "list"],
          },
        ],
      });
    }
    if (kind === "application") {
      registerParticipation(group, runtime);
      registerEntityDeletion(group, runtime, {
        kind,
        example: examples[kind],
        details:
          "Удаление приложения включает его реализации, доску и задачи доски; общие требования и документы сохраняются.",
        catalogs: [
          {
            label: "Проверить оставшиеся приложения (удаление не повторять)",
            args: ["application", "list"],
          },
          { label: "Проверить оставшиеся доски", args: ["board", "list"] },
        ],
      });
    }
    if (kind === "product") registerProductReading(group, runtime);
  }
}
