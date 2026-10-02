import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { entityCreateSchema, entityUpdateSchema } from "@relay/contracts/entities";
import type { EntitiesQuery, EntityDetail } from "@relay/contracts/entities";
import { parse } from "@relay/core/domain/validation";
import { AppError, invariant } from "@relay/core/shared/errors";
import { lintProduct } from "@relay/core/application/product/content";
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
  nativeQuery,
  nativePageResult,
  cursorType,
} from "../command-kit.js";
import { entitiesText, entityText, entitySavedText } from "../presentation/entities.js";
import {
  productOverviewText,
  productOverviewMetricText,
  productLintText,
} from "../presentation/product.js";
import type {
  ProductOverviewCommands,
  ProductOverviewMetricCommands,
  ProductOverviewMetricView,
  ProductOverviewView,
} from "../presentation/product.js";
import { productOverviewMetrics } from "@relay/contracts/entities/product";
import type { ProductOverviewMetric } from "@relay/contracts/entities/product";
import { cardText } from "../presentation/common.js";
import { registerEntityProgress } from "./progress.js";
import {
  registerDocumentCatalog,
  registerDocumentRelations,
  registerDocumentSections,
  documentSectionNames,
} from "./product-documents.js";
import { registerParticipation } from "./product-participation.js";

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
/** Повторяемый тег без разделения по запятой: запятая допустима внутри тега. */
export const collectTag = (value: string, previous: string[] = []) => [...previous, value];

/**
 * Core проверяет согласованность формата, адреса и содержания; CLI лишь дополняет
 * отказ названиями своих флагов, не повторяя предметное правило.
 */
export async function withDocumentInputHint<T>(
  fields: Record<string, unknown> | undefined,
  creating: boolean,
  write: () => Promise<T>,
): Promise<T> {
  if (!fields) return write();
  try {
    return await write();
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "VALIDATION_ERROR") throw error;
    const hint =
      fields.documentFormat === "link"
        ? fields.url === undefined
          ? "Для --document-format link укажите --url с абсолютным адресом http или https; body остаётся необязательным пояснением."
          : undefined
        : fields.url !== undefined
          ? "--url допустим только вместе с --document-format link; для Markdown-документа уберите --url."
          : (creating || fields.documentFormat === "markdown" || fields.body !== undefined) &&
              (typeof fields.body !== "string" || fields.body.trim() === "")
            ? "Для Markdown-документа передайте непустое содержание: --body <text>, --body-file <путь> или --body-file - (stdin). Для внешнего материала укажите --document-format link --url <адрес>."
            : undefined;
    if (!hint) throw error;
    throw new AppError(error.code, `${error.message}. ${hint}`, error.exitCode, error.details);
  }
}

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
    command
      .option(
        "--document-kind <kind>",
        "Назначение: specification/description/rules/instruction/proposal/decision/research",
      )
      .option("--document-status <state>", "Состояние: draft/active/archived")
      .option("--section-id <id>", "Раздел библиотеки")
      .option("--clear-section", "Оставить без раздела")
      .option(
        "--document-format <format>",
        creating
          ? "Формат материала: markdown (по умолчанию) — непустое body; link — внешняя ссылка --url, body — необязательное пояснение"
          : "Новый формат: markdown снимает адрес и требует непустого body; link требует --url",
      )
      .option(
        "--url <url>",
        "Абсолютный адрес http/https материала-ссылки (до 2048 символов); только с форматом link",
      )
      .option(
        "--tag <tag>",
        creating
          ? "Тег материала; повторяйте флаг для нескольких (до 20, до 50 символов)"
          : "Полный новый набор тегов; повторяйте флаг (до 20, до 50 символов)",
        collectTag,
      );
    if (!creating) command.option("--clear-tags", "Снять все теги");
    command
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
        "Заменить прежние продуктовые области; адресные связи — document link",
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
  const text = await readTextFields(context, options, texts(kind));
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
  invariant(
    !(options.clearTags && options.tag !== undefined),
    "INVALID_ARGUMENT",
    "Выберите --tag или --clear-tags",
  );
  const fields: Record<string, unknown> = { kind, ...text };
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
    "documentFormat",
    "url",
  ])
    if (options[name] !== undefined) fields[name] = options[name];
  if (options.tag !== undefined) fields.tags = options.tag;
  if (options.clearTags) fields.tags = [];
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
        "Обычный ввод без JSON. Изменение передаёт только указанные поля и требует прочитанной ревизии.",
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
          examples: [
            [`npx @oim-dev/relay-cli ${kind} list --limit 20`, "Прочитать страницу"],
            ...(kind === "document"
              ? ([
                  [
                    "npx @oim-dev/relay-cli document list --tag API --tag 'Решения' --document-format link",
                    "Ссылки, у которых есть оба тега",
                  ],
                  [
                    "npx @oim-dev/relay-cli document list --unattached true",
                    "Материалы без прикреплений",
                  ],
                ] as const)
              : []),
          ],
          configure(command) {
            paging(command)
              .option("--q <text>", "Поиск")
              .option("--sort <field>", "Сортировка: key/title/updated");
            if (
              kind === "feature" ||
              kind === "scenario" ||
              kind === "implementation" ||
              kind === "document"
            )
              command.option("--status <state>", "Предметное состояние");
            if (kind === "scenario" || kind === "implementation")
              command.option("--feature <ref>", "Родительская фича");
            if (kind === "implementation")
              command
                .option("--application <ref>", "Приложение")
                .option("--scenario <ref>", "Сценарий")
                .option("--target <ref>", "Цель реализации")
                .option("--active <value>", "Участие: true/false");
            if (kind === "document")
              command
                .option("--target <ref>", "Прикрепление к сущности")
                .option("--section <id>", "Раздел; none — без раздела")
                .option("--document-kind <kind>", "Тип документа")
                .option("--document-format <format>", "Формат: markdown/link")
                .option(
                  "--tag <tag>",
                  "Тег; повторите флаг — нужны все выбранные теги, без учёта регистра",
                  collectTag,
                )
                .option(
                  "--unattached <value>",
                  "true — без прикреплений (нет relations и links); false — только прикреплённые",
                )
                .option("--pinned <value>", "Закрепление: true/false")
                .option("--archived <value>", "Архив: true/false");
          },
          async run(context, input) {
            const { cursor: _cursor, limit: _limit, ...filters } = input.options;
            const command = [kind, "list"];
            const query = offsetQuery(context, input.options, command, filters);
            // CLI-фильтр --tag повторяем; в контракте списка это массив tags.
            const { tag, ...rest } = filters as typeof filters & { tag?: string[] };
            const selection = { ...rest, ...(tag === undefined ? {} : { tags: tag }) };
            const data = await context.backend.entities.list({ ...selection, kind, ...query });
            const sections = kind === "document" ? await documentSectionNames(context) : undefined;
            return {
              data,
              page: pageResult(context, command, filters, query, data),
              text: (options) => entitiesText(data, { ...selection, kind }, options, [], sections),
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
        const commands = {
          context: commandInvocation(context, ["inspect", "graph", "context", data.key]),
          ...(kind === "feature"
            ? { scenarios: commandInvocation(context, ["scenario", "list", "--feature", data.key]) }
            : {}),
          ...(kind === "product"
            ? { overview: commandInvocation(context, ["product", "overview"]) }
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
          (kind === "document"
            ? " Формат материала: markdown (по умолчанию) требует непустого body; link требует --url (http/https), а body становится необязательным Markdown-пояснением к ссылке. Смена формата на markdown снимает адрес. Теги: повторяемый --tag; Core обрезает края, отбрасывает пустые и повторы без учёта регистра (сохраняется первое написание), не более 20 тегов по 50 символов." +
              (action === "update"
                ? " --tag заменяет весь набор тегов; для добавления или снятия отдельных тегов используйте document bulk add-tags/remove-tags."
                : "")
            : "") +
          (kind === "implementation" && action === "create"
            ? " Для снятого участия той же пары приложение/цель Core возвращает прежний ID, но заменяет название, описание и совместимую отметку переданными значениями; без --status применяется none. Для возврата участия с сохранением содержания используйте application participation list/replace с прочитанными ревизией состава и версией продукта."
            : ""),
        examples: [
          [
            writeExample(kind, action),
            action === "create"
              ? "Учебный пример: замените требования и адреса данными своего проекта"
              : "Изменить название; замените ревизию прочитанным значением",
          ],
          ...(kind === "document"
            ? ([
                action === "create"
                  ? ([
                      "npx @oim-dev/relay-cli document create --actor agent --name 'Макеты каталога' --document-format link --url https://example.com/catalog --body 'Читать перед изменением карточек' --tag Дизайн --tag Каталог",
                      "Материал-ссылка с пояснением и тегами",
                    ] as const)
                  : ([
                      "npx @oim-dev/relay-cli document update DOC-1 --actor agent --tag API --tag Решения --if-revision 1",
                      "Заменить набор тегов; ревизия — из document get",
                    ] as const),
              ] as const)
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
            const data = await withDocumentInputHint(
              kind === "document" ? fields : undefined,
              true,
              () => context.backend.entities.create(command, author(context)),
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
          }
          const ref = singleton ? "product:passport" : input.argument();
          const command = parse(
            entityUpdateSchema,
            { ref, changes: fields, ifRevision: input.options.ifRevision, requestId },
            "изменение записи",
          );
          const data = await withDocumentInputHint(
            kind === "document" ? fields : undefined,
            false,
            () => context.backend.entities.update(command, author(context)),
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
    if (kind === "document") {
      registerDocumentRelations(group, runtime);
      registerDocumentSections(group, runtime);
      registerDocumentCatalog(group, runtime);
    }
    if (kind === "application") registerParticipation(group, runtime);
    if (kind === "product") registerProductReading(group, runtime);
  }
}

type OverviewOptions = { limit?: number; cursor?: string; metric?: string; blocker?: string };
const overviewMetricsText = productOverviewMetrics.join(", ");

/** Детализация метрики оператора: native cursor Backend связан с командой, метрикой, блокером и проектом. */
async function overviewMetric(context: CommandContext, options: OverviewOptions) {
  const command = ["product", "overview"];
  const filters: { metric?: string | undefined; blocker?: string | undefined } = {
    metric: options.metric,
    blocker: options.blocker,
  };
  const controls = nativeQuery(context, options, command, filters, "snapshot");
  const page = await context.backend.product.overviewMetric({
    // Неизвестную метрику и лишний/отсутствующий блокер отклоняет Backend одинаково в local и HTTP.
    metric: filters.metric as ProductOverviewMetric,
    ...(filters.blocker === undefined ? {} : { blocker: filters.blocker }),
    limit: controls.limit,
    ...(controls.cursor === undefined ? {} : { cursor: controls.cursor }),
  });
  const read = (...args: string[]) => commandInvocation(context, args);
  const commands: ProductOverviewMetricCommands = { overview: read("product", "overview") };
  if (page.metric === "blocker-affected" && page.blocker)
    commands.blocker = read("task", "get", page.blocker.id);
  if (page.metric === "blocker-impact")
    commands.affected = Object.fromEntries(
      page.items.map((blocker) => [
        blocker.id,
        read("product", "overview", "--metric", "blocker-affected", "--blocker", blocker.id),
      ]),
    );
  const data: ProductOverviewMetricView = { ...page, commands };
  return {
    data,
    page: nativePageResult(context, command, filters, controls, page, "snapshot"),
    text: (format: Parameters<typeof productOverviewMetricText>[1]) =>
      productOverviewMetricText(data, format),
  };
}

function registerProductReading(group: Command, runtime: Runtime) {
  registerCommand<OverviewOptions>(group, runtime, {
    name: "overview",
    description: "Обзор состояния продукта и проекта",
    details:
      "Одно чтение согласованного среза: проект, паспорт, задачи по всем шести колонкам, текущая работа, проверка и блокеры с причинами, показатели работы, планы и релизы (собственный статус отдельно от фактической готовности состава), фичи, приложения, реализации, доски и документы. Подборки содержат не более 5 элементов и сообщают полное число и команду полного чтения. Показатели задач пересекаются и не складываются. Без --metric: --limit и --cursor листают только карту продуктовых записей; итоги от них не зависят. Продолжение действительно, пока срез не изменился (snapshotVersion): изменение задачи, плана, релиза, документа или продукта требует начать заново без --cursor. Поле version — версия продуктового состава для participation replace, а не проверка продолжения. Обзор только читает и не решает, какую задачу начинать или завершать.\n\n" +
      "Показатели работы: очередь проверки по выполненным и оставшимся обязательствам, прямые блокеры незавершённой работы, работа in-progress и review вне открытых планов, незавершённая работа по доскам, открытые планы с выполненным составом, запланированные релизы с готовым составом и готовые завершённые планы вне релизов. Готовность обязательств позволяет рассмотреть завершение и не является внешней проверкой; работа вне открытых планов — сигнал, а не ошибка; блокеры считаются только напрямую.\n\n" +
      `--metric <метрика> переключает команду на полный постраничный список одного показателя: ${overviewMetricsText}. Для blocker-affected обязателен --blocker с ID или ключом задачи-блокера; для остальных метрик --blocker запрещён. В этом режиме --limit (1–100, по умолчанию из настроек вывода) и --cursor листают элементы метрики; total от размера страницы не зависит. Курсор сохраняет проект, подключение, метрику, блокер и размер страницы; достаточно передать только --cursor. Изменение задачи, плана, релиза, доски, документа или продукта между страницами даёт VERSION_CONFLICT — начните заново без --cursor.`,
    examples: [
      ["npx @oim-dev/relay-cli product overview", "Понять состояние продукта и выбрать чтение"],
      [
        "npx @oim-dev/relay-cli product overview --limit 20 --format json",
        "Полный машинный срез и первые 20 записей карты",
      ],
      [
        "npx @oim-dev/relay-cli product overview --metric review-obligations-met",
        "Все задачи на проверке, завершение которых можно рассмотреть",
      ],
      [
        "npx @oim-dev/relay-cli product overview --metric blocker-impact --limit 10 --format json",
        "Прямые блокеры: точные счётчики и команды состава",
      ],
      [
        "npx @oim-dev/relay-cli product overview --metric blocker-affected --blocker PRODUCT-1",
        "Все задачи, которые PRODUCT-1 задерживает напрямую",
      ],
    ],
    configure: (command) =>
      paging(command)
        .option("--metric <metric>", `Полный список показателя: ${overviewMetricsText}`)
        .option(
          "--blocker <task>",
          "ID или ключ задачи-блокера; только с --metric blocker-affected",
        ),
    async run(context, input) {
      // Курсор детализации сам восстанавливает метрику и блокер: достаточно одного --cursor.
      if (input.options.metric !== undefined || cursorType(input.options.cursor) === "native")
        return overviewMetric(context, input.options);
      invariant(
        input.options.blocker === undefined,
        "INVALID_ARGUMENT",
        "--blocker применяется только вместе с --metric blocker-affected",
      );
      const command = ["product", "overview"];
      const query = offsetQuery(context, input.options, command, {});
      const overview = await context.backend.product.overview();
      invariant(
        !query.version || query.version === overview.snapshotVersion,
        "VERSION_CONFLICT",
        "Срез проекта изменился после первой страницы: изменились задачи, планы, релизы, документы или продукт. Версия среза проверяет неизменность текущего состояния и не даёт доступа к историческому снимку. Начните product overview заново без --cursor.",
      );
      const next = query.offset + query.limit;
      const items = overview.items.slice(query.offset, next);
      const read = (...args: string[]) => commandInvocation(context, args);
      const commands: ProductOverviewCommands = {
        passport: read("product", "get"),
        passportHelp: read("product", "create", "--help"),
        progress: read("product", "progress"),
        features: read("feature", "list"),
        applications: read("application", "list"),
        implementations: read("implementation", "list"),
        boards: read("board", "list"),
        tasks: read("task", "list"),
        inProgress: read("task", "list", "--column", "in-progress"),
        review: read("task", "list", "--column", "review"),
        blocked: read("task", "list", "--readiness", "blocked"),
        readyToStart: read("task", "list", "--readiness", "ready"),
        plans: read("plan", "list"),
        activePlans: read("plan", "list", "--status", "active"),
        releases: read("release", "list"),
        plannedReleases: read("release", "list", "--status", "planned"),
        releasedReleases: read("release", "list", "--status", "released"),
        documents: read("document", "list"),
        pinnedDocuments: read("document", "list", "--pinned", "true", "--status", "active"),
        sections: read("document", "section", "list"),
        metrics: Object.fromEntries(
          productOverviewMetrics
            .filter((metric) => metric !== "blocker-affected")
            .map((metric) => [metric, read("product", "overview", "--metric", metric)]),
        ) as ProductOverviewCommands["metrics"],
        blockerAffected: Object.fromEntries(
          overview.snapshot.operator.blockerImpact.items.map((blocker) => [
            blocker.id,
            read("product", "overview", "--metric", "blocker-affected", "--blocker", blocker.id),
          ]),
        ),
      };
      const data: ProductOverviewView = {
        ...overview,
        items,
        readiness: overview.readiness.filter((entry) => items.some((item) => item.id === entry.id)),
        readinessCounts: {
          total: overview.readiness.length,
          ready: overview.readiness.filter((entry) => entry.status === "done").length,
          stale: overview.readiness.filter((entry) => entry.stale > 0).length,
        },
        total: overview.items.length,
        nextOffset: next < overview.items.length ? next : null,
        commands,
      };
      return {
        data,
        // Продолжение карты защищает полный срез; прежний version в data не подменяется.
        page: pageResult(context, command, {}, query, {
          items,
          total: data.total,
          nextOffset: data.nextOffset,
          version: overview.snapshotVersion,
        }),
        text: (options) => productOverviewText(data, options, query.offset),
      };
    },
  });
  registerCommand(group, runtime, {
    name: "validate",
    description: "Проверить целостность продукта",
    details: "Чтение с проверкой структурных инвариантов; не внешняя приёмка требований.",
    examples: [["npx @oim-dev/relay-cli product validate", "Проверить продукт"]],
    async run(context) {
      const state = await context.backend.product.state();
      return {
        data: { valid: true, records: state.records.length, version: state.version },
        text: (options) =>
          cardText(
            {
              title: "Структура продукта проверена",
              fields: [
                ["Проверено записей", state.records.length],
                ["Версия", state.version],
              ],
              sections: [
                {
                  title: "Границы проверки",
                  body: "Структурные инварианты соблюдены. Это не внешняя приёмка и не подтверждение полноты требований.",
                },
              ],
              commands: [
                {
                  label: "Проверить содержание",
                  command: commandInvocation(context, ["product", "lint"]),
                },
              ],
            },
            options,
          ),
      };
    },
  });
  registerCommand<{ id?: string; limit?: number; cursor?: string }>(group, runtime, {
    name: "lint",
    description: "Найти структурные недостатки описаний",
    details: "Рекомендации не изменяют записи и не доказывают полноту требований.",
    examples: [["npx @oim-dev/relay-cli product lint", "Прочитать рекомендации"]],
    configure: (command) => paging(command).option("--id <ref>", "Выбранная запись"),
    async run(context, input) {
      const command = ["product", "lint"];
      const filters = input.options.id ? { id: input.options.id } : {};
      const query = offsetQuery(context, input.options, command, filters);
      const state = await context.backend.product.state();
      invariant(
        !query.version || query.version === state.version,
        "VERSION_CONFLICT",
        "Продукт изменился. Начните lint без --cursor.",
      );
      const selected = filters.id ? await context.backend.product.entity(filters.id) : undefined;
      invariant(
        !selected || selected.fields.kind !== "implementation",
        "INVALID_ARGUMENT",
        "Для проверки реализаций запустите product lint без --id; отдельная реализация не поддержана контрактом lint.",
      );
      const data = {
        ...lintProduct(state, {
          ...(selected ? { id: selected.id } : {}),
          offset: query.offset,
          limit: query.limit,
        }),
        version: state.version,
      };
      return {
        data,
        page: pageResult(context, command, filters, query, { ...data, items: data.warnings }),
        text: (options) =>
          productLintText(
            data,
            options,
            filters,
            new Map(state.records.map((record) => [record.id, record.key ?? record.id])),
          ),
      };
    },
  });
}
