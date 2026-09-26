import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import {
  entityKindSchema,
  entityCreateSchema,
  entityUpdateSchema,
} from "@relay/contracts/entities";
import type { EntityKind, EntitiesQuery, EntityPageQuery } from "@relay/contracts/entities";
import { AppError } from "@relay/core/shared/errors";
import { parse } from "@relay/core/domain/validation";
import { commandGroup, registerCommand } from "../command.js";
import { author } from "../context.js";
import type { Runtime } from "../context.js";
import { integer } from "../options.js";
import {
  entitiesText,
  entityTypesText,
  entityText,
  entityTypeText,
  entityResolvedText,
  entitySavedText,
  entityContinuation,
} from "../presentation/entities.js";
import { safeText } from "../presentation/text.js";

type PageOptions = EntityPageQuery & { snapshotVersion?: string };
const pageOptions = (command: Command) =>
  command
    .option("--limit <n>", "Размер страницы 1–100", integer(1, 100))
    .option("--offset <n>", "Смещение страницы", integer(0, Number.MAX_SAFE_INTEGER))
    .option(
      "--snapshot-version <version>",
      "Версия первой страницы; при изменении перечитайте выборку",
    );
const pageQuery = <T extends PageOptions>({ snapshotVersion, ...options }: T) => ({
  ...options,
  ...(snapshotVersion ? { version: snapshotVersion } : {}),
});
type Fields = {
  name?: string;
  title?: string;
  summary?: string;
  description?: string;
  body?: string;
  feature?: string;
  application?: string;
  target?: string;
  board?: string;
  slug?: string;
  prefix?: string;
  type?: string;
  documentKind?: string;
  documentStatus?: string;
  sectionId?: string;
  pinned?: boolean;
  relations?: string;
  documentSections?: string;
  clearSection?: boolean;
  status?: string;
  column?: string;
  parent?: string;
  targets?: string[];
  dependencies?: string[];
  related?: string[];
  json?: string;
  ifRevision?: number;
  requestId?: string;
};

/** Общие явные поля; допустимость для конкретного вида проверяется его контрактом. */
function fieldOptions(command: Command) {
  return command
    .option(
      "--name <text>",
      "Однострочное название продукта, фичи, сценария, приложения или документа",
    )
    .option("--title <text>", "Однострочный заголовок задачи или реализации")
    .option("--summary <text>", "Краткое многострочное обычное описание")
    .option("--description <markdown>", "Полное описание в Markdown")
    .option("--body <markdown>", "Полный Markdown документа")
    .option("--feature <ref>", "Родительская фича сценария: ключ или ID")
    .option("--application <ref>", "Приложение реализации: ключ или ID")
    .option("--target <ref>", "Фича или сценарий реализации: ключ или ID")
    .option("--board <ref>", "Доска задачи: ключ или ID")
    .option("--slug <slug>", "Адрес создаваемого приложения")
    .option("--prefix <prefix>", "Префикс задач приложения")
    .option("--type <type>", "Тип приложения: frontend, backend или internal")
    .option(
      "--document-kind <kind>",
      "Тип документа: specification, description, rules, instruction, proposal, decision, research",
    )
    .option("--document-status <state>", "Состояние документа: draft, active или archived")
    .option("--section-id <id>", "Постоянный ID раздела библиотеки")
    .option("--clear-section", "Оставить документ без раздела")
    .option("--pinned <value>", "Закрепление документа: true или false", (value) => {
      if (value !== "true" && value !== "false")
        throw new AppError("INVALID_ARGUMENT", "Ожидается true или false");
      return value === "true";
    })
    .option(
      "--relations <json>",
      "Массив связей документа: target {kind,id}, type references/documents, description Markdown",
    )
    .option("--document-sections <json>", "Упорядоченный массив разделов проекта: id и name")
    .option("--status <status>", "Состояние реализации: none, partial или done")
    .option("--column <column>", "Начальная колонка задачи")
    .option("--parent <ref>", "Родитель задачи: ключ или ID")
    .option("--targets <refs...>", "Продуктовые цели задачи или документа: ключи или ID")
    .option("--dependencies <refs...>", "Зависимости создаваемой задачи: ключи или ID")
    .option("--related <refs...>", "Связанные задачи: ключи или ID")
    .option(
      "--json <json>",
      "Дополнительные типизированные поля объекта; явные параметры имеют приоритет",
    )
    .option("--request-id <id>", "Идентификатор корреляции, не дедупликации; по умолчанию UUID");
}
function fields(kind: EntityKind, options: Fields, creating: boolean) {
  let source: unknown = {};
  if (options.json !== undefined) {
    try {
      source = JSON.parse(options.json);
    } catch {
      throw new AppError("INVALID_JSON", "Параметр --json должен содержать JSON-объект");
    }
    if (!source || typeof source !== "object" || Array.isArray(source))
      throw new AppError("INVALID_JSON", "Ожидается объект полей сущности");
  }
  const {
    json: _json,
    requestId: _requestId,
    ifRevision: _revision,
    feature,
    relations,
    documentSections,
    clearSection,
    ...values
  } = options;
  const arrays: Record<string, unknown> = {};
  for (const [name, value] of Object.entries({ relations, documentSections })) {
    if (value === undefined) continue;
    try {
      arrays[name] = JSON.parse(value);
    } catch {
      throw new AppError("INVALID_JSON", `Поле ${name} должно содержать JSON-массив`);
    }
  }
  return {
    ...(creating && ["product", "feature", "application", "document"].includes(kind)
      ? { summary: "" }
      : {}),
    ...(source as object),
    ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)),
    ...arrays,
    ...(clearSection ? { sectionId: null } : {}),
    ...(feature === undefined ? {} : { featureId: feature }),
    kind,
  };
}

/** Каталог видов и предметные операции над девятью основными сущностями. */
export function registerEntities(program: Command, runtime: Runtime): void {
  const group = commandGroup(program, {
    name: "entities",
    description: "Виды, записи и действия движка сущностей",
    details:
      "Во всех ссылках допустимы ключи или ID. Продуктовые линки сохраняются по ID; граф читает только явно установленные связи Core. Старые ключи работают как алиасы. Поля и действия объясняет entities type.",
    examples: [
      ["relay-cli entities types", "Узнать доступные виды"],
      ["relay-cli entities list --kind task --board BOARD-WEB", "Найти задачи доски"],
      ["relay-cli entities get WEB-24", "Прочитать полное содержание"],
    ],
  });
  registerCommand<PageOptions>(group, runtime, {
    name: "types",
    description: "Перечислить виды сущностей и их назначение",
    details: "Каталог определений доступен также для пустого проекта.",
    examples: [["relay-cli entities types", "Прочитать виды и действия"]],
    configure: pageOptions,
    run: async (context, input) => {
      const query = pageQuery(input.options);
      const data = await context.backend.entities.types(query);
      return { data, text: (options) => entityTypesText(data, query, options) };
    },
  });
  registerCommand(group, runtime, {
    name: "type <kind>",
    arguments: { kind: "Вид, например task, feature или implementation" },
    description: "Прочитать контракт вида, поля, фильтры и правила ключей",
    details:
      "JSON содержит схемы чтения, создания и изменения. Текст показывает назначение и поля.",
    examples: [["relay-cli entities type task", "Изучить контракт задачи"]],
    run: async (context, input) => {
      const data = await context.backend.entities.describe({
        kind: parse(entityKindSchema, input.argument(), "вид сущности"),
      });
      return { data, text: (options) => entityTypeText(data, options) };
    },
  });
  registerCommand<EntitiesQuery & PageOptions>(group, runtime, {
    name: "list",
    description: "Найти краткие карточки сущностей",
    details:
      "Полный текст читается через get. Фильтры применяются в Core до пагинации; продолжение привязано к снимку.",
    examples: [
      ["relay-cli entities list --kind task --board BOARD-WEB --limit 20", "Найти задачи"],
      [
        "relay-cli entities list --kind implementation --scenario SCENARIO-1",
        "Найти реализации сценария",
      ],
    ],
    configure: (command) =>
      pageOptions(command)
        .option("--kind <kind>", "Вид сущностей")
        .option("--q <text>", "Поиск по ключам, ID, названию и краткому описанию")
        .option("--refs <refs...>", "Ключи или ID выбранных сущностей")
        .option("--board <ref>", "Доска задач: ключ или ID")
        .option("--application <ref>", "Приложение: ключ или ID")
        .option("--feature <ref>", "Фича: ключ или ID")
        .option("--scenario <ref>", "Сценарий: ключ или ID")
        .option("--target <ref>", "Явная продуктовая цель: ключ или ID")
        .option("--parent <ref>", "Родитель задачи: ключ или ID")
        .option("--status <status>", "Предметное состояние")
        .option("--active <value>", "Участие реализации: true или false")
        .option("--section <id>", "Раздел документов; none — без раздела")
        .option("--document-kind <kind>", "Тип документа")
        .option("--pinned <value>", "Закрепление документа: true или false")
        .option("--archived <value>", "Только архив либо исключить архив: true или false")
        .option("--sort <field>", "Сортировка: key, title или updated"),
    run: async (context, input) => {
      const query = pageQuery(input.options);
      const data = await context.backend.entities.list(query);
      return { data, text: (options) => entitiesText(data, query, options) };
    },
  });
  for (const action of ["get", "resolve"] as const)
    registerCommand<{ kind?: EntityKind }>(group, runtime, {
      name: `${action} <ref>`,
      arguments: { ref: "Ключ или ID сущности; допустим kind:ID" },
      description:
        action === "get"
          ? "Прочитать все данные одной сущности"
          : "Разрешить ключ или ID в постоянный адрес",
      details:
        "Проект задаётся общим контекстом команды. При коллизии укажите вид или постоянный адрес.",
      examples: [[`relay-cli entities ${action} WEB-24`, "Обратиться по читаемому ключу"]],
      configure: (command) => command.option("--kind <kind>", "Уточнить ожидаемый вид"),
      run: async (context, input) => {
        const query = { ref: input.argument(), ...input.options };
        if (action === "get") {
          const data = await context.backend.entities.get(query);
          return { data, text: (options) => entityText(data, options) };
        }
        const data = await context.backend.entities.resolve(query);
        return { data, text: entityResolvedText(data) };
      },
    });
  for (const action of ["keys", "key-spaces"] as const)
    registerCommand<PageOptions>(group, runtime, {
      name: `${action} <${action === "key-spaces" ? "kind" : "ref"}>`,
      arguments:
        action === "key-spaces" ? { kind: "Вид сущности" } : { ref: "Ключ или ID сущности" },
      description: {
        keys: "Прочитать текущий ключ и прежние алиасы",
        "key-spaces": "Перечислить актуальные области нумерации и префиксы",
      }[action],
      details: "Список ограничен и содержит продолжение той же версии.",
      examples: [
        [
          `relay-cli entities ${action} ${action === "key-spaces" ? "task" : "WEB-24"}`,
          "Прочитать страницу",
        ],
      ],
      configure: pageOptions,
      run: async (context, input) => {
        const query = pageQuery(input.options);
        const ref = input.argument();
        if (action === "keys") {
          const data = await context.backend.entities.keys({ ref, ...query });
          return {
            data,
            text: [
              data.items
                .map(
                  (item) => `${safeText(item.key)} · ${item.current ? "текущий" : "прежний алиас"}`,
                )
                .join("\n"),
              entityContinuation(data, `keys '${ref}'`, query),
            ].join("\n\n"),
          };
        }
        const data = await context.backend.entities.keySpaces({
          kind: parse(entityKindSchema, ref, "вид сущности"),
          ...query,
        });
        return {
          data,
          text: [
            data.items
              .map((item) => `${safeText(item.title)} · ${safeText(item.pattern)}`)
              .join("\n") || "Пространств ключей пока нет.",
            entityContinuation(data, `key-spaces ${ref}`, query),
          ].join("\n\n"),
        };
      },
    });
  registerCommand<Fields>(group, runtime, {
    name: "create <kind>",
    arguments: {
      kind: "Создаваемый вид: product, feature, scenario, application, implementation, task или document",
    },
    description: "Создать сущность и её обязательные связи",
    details:
      "Ключ назначает Core. Все ссылочные поля принимают ключи или ID. Схема: entities type <kind>. Задача и её зависимости создаются одной операцией.",
    examples: [
      [
        "relay-cli --actor agent entities create task --board BOARD-WEB --title 'Сделать форму' --targets WEB-SI-1 --dependencies API-8",
        "Создать задачу реализации с зависимостью",
      ],
    ],
    configure: fieldOptions,
    run: async (context, input) => {
      const kind = parse(entityKindSchema, input.argument(), "вид сущности");
      const command = parse(
        entityCreateSchema,
        {
          data: fields(kind, input.options, true),
          requestId: input.options.requestId ?? randomUUID(),
        },
        "создание сущности",
      );
      const data = await context.backend.entities.create(command, author(context));
      return { data, text: entitySavedText(data) };
    },
  });
  registerCommand<Fields>(group, runtime, {
    name: "update <ref>",
    arguments: { ref: "Ключ или ID изменяемой сущности" },
    description: "Изменить поля сущности с проверкой ревизии",
    details:
      "Вид определяется общим резолвером. Передавайте только изменяемые поля; отсутствие поля сохраняет его значение. Ключ меняется через rename.",
    examples: [
      [
        "relay-cli --actor agent entities update WEB-24 --title 'Уточнённая задача' --if-revision 2",
        "Сохранить содержание",
      ],
    ],
    configure: (command) =>
      fieldOptions(command).requiredOption(
        "--if-revision <n>",
        "Прочитанная ревизия записи",
        integer(0, Number.MAX_SAFE_INTEGER),
      ),
    run: async (context, input) => {
      const ref = input.argument();
      const target = await context.backend.entities.resolve({ ref });
      const command = parse(
        entityUpdateSchema,
        {
          ref,
          changes: fields(target.ref.kind, input.options, false),
          ifRevision: input.options.ifRevision,
          requestId: input.options.requestId ?? randomUUID(),
        },
        "изменение сущности",
      );
      const data = await context.backend.entities.update(command, author(context));
      return { data, text: entitySavedText(data) };
    },
  });
  registerCommand<{ ifRevision: number; requestId?: string }>(group, runtime, {
    name: "rename <ref> <key>",
    arguments: { ref: "Ключ или ID сущности", key: "Новый читаемый ключ, например TASK-WEB-23" },
    description: "Изменить ключ, сохранив ID, отношения и алиасы",
    details:
      "Прежний ключ остаётся адресом той же сущности. Коллизия и устаревшая ревизия отклоняются.",
    examples: [
      [
        "relay-cli --actor agent entities rename WEB-24 TASK-WEB-23 --if-revision 2",
        "Изменить формат ключа",
      ],
    ],
    configure: (command) =>
      command
        .requiredOption(
          "--if-revision <n>",
          "Прочитанная ревизия",
          integer(0, Number.MAX_SAFE_INTEGER),
        )
        .option("--request-id <id>", "Идентификатор корреляции, не дедупликации"),
    run: async (context, input) => {
      const data = await context.backend.entities.rename(
        {
          ref: input.argument(),
          key: input.argument(1),
          ifRevision: input.options.ifRevision,
          requestId: input.options.requestId ?? randomUUID(),
        },
        author(context),
      );
      return { data, text: entitySavedText(data) };
    },
  });
  registerCommand<{
    board?: string;
    column: "inbox" | "ready" | "in-progress" | "review" | "done" | "cancelled";
    before?: string;
    ifRevision: number;
    requestId?: string;
  }>(group, runtime, {
    name: "move-task <ref>",
    arguments: { ref: "Ключ или ID задачи" },
    description: "Переместить задачу в колонку или на другую доску",
    details:
      "Доска и позиция также принимают ключи или ID. При смене доски Core сохраняет прежние ключи.",
    examples: [
      [
        "relay-cli --actor agent entities move-task WEB-24 --column review --if-revision 2",
        "Отправить работу на проверку",
      ],
    ],
    configure: (command) =>
      command
        .requiredOption("--column <column>", "Целевая колонка")
        .option("--board <ref>", "Ключ или ID целевой доски")
        .option("--before <ref>", "Ключ или ID следующей задачи")
        .requiredOption(
          "--if-revision <n>",
          "Прочитанная ревизия",
          integer(0, Number.MAX_SAFE_INTEGER),
        )
        .option("--request-id <id>", "Идентификатор корреляции, не дедупликации"),
    run: async (context, input) => {
      const { requestId, before, ...options } = input.options;
      const data = await context.backend.entities.moveTask(
        {
          ...options,
          ref: input.argument(),
          before: before ?? null,
          requestId: requestId ?? randomUUID(),
        },
        author(context),
      );
      return { data, text: entitySavedText(data) };
    },
  });
  registerCommand<{
    relation: "depends-on" | "related" | "parent";
    remove?: boolean;
    ifRevision: number;
    requestId?: string;
  }>(group, runtime, {
    name: "link-task <ref> <target>",
    arguments: { ref: "Ключ или ID текущей задачи", target: "Ключ или ID второй задачи" },
    description: "Установить или снять предметную связь задач",
    details:
      "Зависимость проверяет циклы и влияет на блокировку завершения. Родительство означает декомпозицию.",
    examples: [
      [
        "relay-cli --actor agent entities link-task WEB-24 API-8 --relation depends-on --if-revision 2",
        "Указать необходимый результат другой задачи",
      ],
    ],
    configure: (command) =>
      command
        .requiredOption("--relation <relation>", "depends-on, related или parent")
        .option("--remove", "Удалить выбранную связь")
        .requiredOption(
          "--if-revision <n>",
          "Прочитанная ревизия",
          integer(0, Number.MAX_SAFE_INTEGER),
        )
        .option("--request-id <id>", "Идентификатор корреляции, не дедупликации"),
    run: async (context, input) => {
      const { requestId, ...options } = input.options;
      const data = await context.backend.entities.linkTask(
        {
          ...options,
          ref: input.argument(),
          target: input.argument(1),
          requestId: requestId ?? randomUUID(),
        },
        author(context),
      );
      return { data, text: entitySavedText(data) };
    },
  });
}
