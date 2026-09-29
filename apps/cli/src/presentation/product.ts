import { listText, cardText, commandText } from "./common.js";
import { filterFields } from "./entities.js";
import type {
  ProductContext,
  ProductList,
  ProductListQuery,
  ProductMutation,
  ProductOverview,
  ProductOverviewSnapshot,
  ProductState,
} from "@relay/core/domain/product";
import type { ContentWarning } from "@relay/core/application/product/content";
import type { ProductContentQuery } from "@relay/core/application/product/content";
import type { TextOptions } from "./theme.js";
import wrapAnsi from "wrap-ansi";
import { wrap, section } from "./layout.js";
import { renderMarkdown } from "./markdown.js";
import { safeText, previewText } from "./text.js";
import type {
  ProductEntity,
  ProductEntitySummary,
  ProductEntitiesQuery,
} from "@relay/core/domain/product-implementation";

type RecordView = ProductEntity;
const kinds: Record<string, string> = {
  passport: "Паспорт",
  feature: "Фича",
  scenario: "Сценарий",
  application: "Приложение",
  document: "Документ",
  scope: "Состав реализации",
  contract: "Контракт",
  implementation: "Реализация",
};
const statuses = { none: "Не реализовано", partial: "Частично", done: "Готово" };
const nameOf = (record: RecordView) =>
  "name" in record.fields
    ? record.fields.name
    : "title" in record.fields
      ? record.fields.title
      : `Состав ${record.fields.applicationId}`;

/** Представление предметной записи: метаданные не смешиваются с Markdown-содержанием. */
export function productRecordText(record: RecordView, options: TextOptions): string {
  const fields = record.fields;
  const head = section(
    wrap(`${kinds[fields.kind]} · ${safeText(nameOf(record))}`, options.width),
    wrap(
      `${record.key ? `Ключ: ${record.key}\n` : ""}ID: ${record.id}\nРевизия: ${record.revision}\nАвтор: ${safeText(record.updatedBy)}`,
      options.width,
    ),
    options,
  );
  const parts = [head];
  if ("summary" in fields && fields.summary)
    parts.push(wrap(safeText(fields.summary), options.width));
  if (fields.kind === "scenario")
    parts.push(wrap(`Родительская фича: ${fields.featureId}`, options.width));
  if (fields.kind === "implementation")
    parts.push(
      wrap(
        `Приложение: ${fields.applicationId}\nФича: ${fields.featureId}\nСценарий: ${fields.scenarioId ?? "Общий вклад"}\n${fields.active ? statuses[fields.status] : "Участие снято"}`,
        options.width,
      ),
    );
  if (fields.kind === "application")
    parts.push(
      `Тип: ${{ frontend: "Фронтенд", backend: "Бэкенд", internal: "Внутренний инструмент" }[fields.type]}`,
      wrap(`Адрес приложения и доски: ${safeText(fields.slug)}`, options.width),
      wrap(`Префикс задач: ${safeText(fields.prefix ?? fields.slug.toUpperCase())}`, options.width),
    );
  if (fields.kind === "scope") {
    parts.push(wrap(`Приложение: ${fields.applicationId}`, options.width));
    if (!fields.contracts.length) parts.push("Контрактов пока нет.");
    for (const contract of fields.contracts)
      parts.push(
        section(
          safeText(contract.title),
          [
            wrap(
              `ID: ${contract.id}\nФича: ${contract.featureId}\nСценарий: ${contract.scenarioId ?? "общий вклад"}\n${contract.active ? statuses[contract.status] : "Участие снято"}`,
              options.width,
            ),
            renderMarkdown(contract.description, options),
          ].join("\n\n"),
          options,
        ),
      );
  } else {
    parts.push(
      renderMarkdown(fields.kind === "document" ? fields.body : fields.description, options),
    );
    if (fields.kind === "document") {
      parts.push(
        `Тип: ${safeText(fields.documentKind)}\nСостояние: ${safeText(fields.documentStatus ?? "active")}\nРаздел: ${safeText(fields.sectionId ?? "Без раздела")}\nЗакреплён: ${fields.pinned ? "да" : "нет"}`,
      );
      const links = fields.links.map((link) =>
        wrap(
          safeText(
            link.kind === "product"
              ? "Прежняя область: продукт"
              : `Прежняя область: ${link.kind}:${link.id}`,
          ),
          options.width,
        ),
      );
      const relations = (fields.relations ?? []).map(
        (link) =>
          `${safeText(link.type)}: ${safeText(`${link.target.kind}:${link.target.id}`)}${link.description ? `\n${renderMarkdown(link.description, options)}` : ""}`,
      );
      parts.push(section("Связи", [...links, ...relations].join("\n\n") || "Связей нет.", options));
    }
  }
  return parts.join("\n\n");
}

function listing(
  items: ProductOverview["items"],
  options: TextOptions,
  readiness: ProductOverview["readiness"] = [],
  title = "Записи продукта",
  emptyMessage = "На этой странице записей нет.",
): string {
  const states = new Map(readiness.map((item) => [item.id, item.status]));
  return listText(
    {
      title,
      items: items.map((item) => ({
        key: item.key ?? item.id,
        title: item.name,
        details: [
          kinds[item.kind] ?? item.kind,
          ...(states.has(item.id)
            ? [`Готовность (расчёт): ${statuses[states.get(item.id)!]}`]
            : []),
          ...(item.kind === "scope"
            ? ["Техническая запись состава; приложение не раскрывается в этой сводке."]
            : []),
          ...(item.summary ? [previewText(item.summary, 120)] : []),
        ],
      })),
      emptyMessage,
    },
    options,
  );
}

export function productListText(
  data: ProductList,
  _query: ProductListQuery,
  options: TextOptions,
): string {
  const items = data.items.map((record) => ({
    id: record.id,
    ...(record.key ? { key: record.key } : {}),
    revision: record.revision,
    kind: record.fields.kind,
    name: nameOf(record),
    summary: "summary" in record.fields ? record.fields.summary : "",
  }));
  const parts = [
    section(`Записи продукта · ${items.length} из ${data.total}`, listing(items, options), options),
  ];
  return parts.join("\n\n");
}

/** Исполняемые команды дальнейшего чтения; каждая сохраняет подключение исходного вызова. */
export type ProductOverviewCommands = {
  passport: string;
  passportHelp: string;
  progress: string;
  features: string;
  applications: string;
  implementations: string;
  boards: string;
  tasks: string;
  inProgress: string;
  review: string;
  blocked: string;
  readyToStart: string;
  plans: string;
  activePlans: string;
  releases: string;
  plannedReleases: string;
  releasedReleases: string;
  documents: string;
  pinnedDocuments: string;
  sections: string;
};

export type ProductOverviewView = ProductOverview & {
  total: number;
  nextOffset: number | null;
  readinessCounts: { total: number; ready: number; stale: number };
  commands: ProductOverviewCommands;
};

type Snapshot = ProductOverviewSnapshot;
type Preview<T> = { total: number; shown: number; hasMore: boolean; items: T[] };
type AttentionTask = Snapshot["attention"]["inProgress"]["items"][number];
type OverviewPlan = Snapshot["plans"]["active"]["items"][number];
type OverviewRelease = Snapshot["releases"]["upcoming"]["items"][number];

// Формулировки направления как в task links: «Зависит от», «Подзадача».
const relations = { dependency: "зависит от", subtask: "подзадача" };

/** Согласование существительного с числом: 1 задача, 2 задачи, 5 задач. */
function plural(count: number, forms: readonly [string, string, string]): string {
  const tens = count % 100;
  const units = count % 10;
  if (tens >= 11 && tens <= 14) return forms[2];
  if (units === 1) return forms[0];
  return units >= 2 && units <= 4 ? forms[1] : forms[2];
}
/** Родительный падеж после «из N»: из 1 задачи, из 5 задач. */
const ofTasks = (count: number) => plural(count, ["задачи", "задач", "задач"]);
const ofPlans = (count: number) => plural(count, ["плана", "планов", "планов"]);
const planStatuses = {
  draft: "черновик",
  active: "в работе",
  completed: "завершён",
  cancelled: "отменён",
};
const releaseStatuses = { planned: "запланирован", released: "выпущен", cancelled: "отменён" };

/** Перенос обычного текста без висячих пробелов в начале и конце строк. */
function prose(text: string, width: number): string {
  return wrapAnsi(safeText(text), Math.max(1, width), { hard: true, trim: true, wordWrap: true });
}

/** Markdown-фрагмент сохраняет исходные строки и отступы; переносятся только длинные строки. */
function indent(text: string, width: number, prefix = "  ", markdown = false): string {
  const body = markdown
    ? safeText(text)
        .split("\n")
        .map((line) => wrap(line, Math.max(1, width - prefix.length)))
        .join("\n")
    : prose(text, Math.max(1, width - prefix.length));
  return body
    .split("\n")
    .map((line) => (line ? prefix + line : line))
    .join("\n");
}

function outputWidth(options: TextOptions): number {
  return Number.isFinite(options.width)
    ? Math.max(24, Math.min(160, Math.floor(options.width)))
    : 100;
}

/** Заголовок подборки честно сообщает, полный ли показанный перечень. */
function previewTitle(title: string, preview: Preview<unknown>): string {
  if (!preview.total) return `${title} · 0`;
  return preview.hasMore
    ? `${title} · показано ${preview.shown} из ${preview.total}`
    : `${title} · все ${preview.total}`;
}

function previewBlock<T>(
  title: string,
  preview: Preview<T>,
  render: (item: T) => string,
  empty: string,
  full: string,
  options: TextOptions,
  emptyCommand?: string,
): string {
  const width = outputWidth(options);
  const parts = [prose(previewTitle(title, preview), width)];
  if (!preview.items.length)
    parts.push(
      indent(empty, width) + (emptyCommand ? `\n${commandText(emptyCommand, options)}` : ""),
    );
  else parts.push(preview.items.map(render).join("\n"));
  if (preview.hasMore)
    parts.push(
      `${indent(`Полный список (ещё ${preview.total - preview.shown}):`, width)}\n${commandText(full, options)}`,
    );
  return parts.join("\n");
}

function taskLine(task: AttentionTask, options: TextOptions): string {
  const width = outputWidth(options);
  const lines = [
    indent(`${task.key} — ${task.title || "Без названия"}`, width),
    indent(
      [
        `доска ${task.board.name} (${task.board.prefix})`,
        `колонка ${task.column}`,
        task.acceptance.total
          ? `критерии ${task.acceptance.completed} из ${task.acceptance.total}`
          : "критериев нет",
        ...(task.column === "done" && !task.completed ? ["обязательства не выполнены"] : []),
      ].join(" · "),
      width,
      "    ",
    ),
  ];
  if (task.blockers.total) {
    const reasons = task.blockers.items.map(
      (blocker) =>
        `${blocker.key} (${relations[blocker.relation]}, ${blocker.column})${blocker.title ? ` ${blocker.title}` : ""}`,
    );
    const rest = task.blockers.total - task.blockers.items.length;
    lines.push(
      indent(
        `Ждёт выполнения: ${reasons.join("; ")}${rest > 0 ? `; и ещё ${rest}` : ""}`,
        width,
        "    ",
      ),
    );
  }
  return lines.join("\n");
}

function planLine(plan: OverviewPlan, options: TextOptions): string {
  const width = outputWidth(options);
  const counts = plan.counts;
  const lines = [
    indent(`${plan.key} — ${plan.title}`, width),
    indent(
      `Статус: ${planStatuses[plan.status]} · состав: ${
        counts.total
          ? `выполнено ${counts.completed} из ${counts.total} ${ofTasks(counts.total)} (${counts.percent}%)`
          : "задач нет"
      }${plan.ready ? " · фактически готов" : ""}`,
      width,
      "    ",
    ),
    indent(
      `Этапы: выполнено ${plan.stages.completed} из ${plan.stages.total}${
        plan.nextStage ? ` · следующий: ${plan.nextStage.title}` : ""
      }`,
      width,
      "    ",
    ),
  ];
  if (counts.active || counts.review || counts.blocked)
    lines.push(
      indent(
        `В работе ${counts.active} · на проверке ${counts.review} · заблокировано ${counts.blocked}`,
        width,
        "    ",
      ),
    );
  const about = plan.summary || plan.goal.text;
  if (about)
    lines.push(
      indent(
        `${plan.summary ? "" : "Цель: "}${about}${!plan.summary && plan.goal.truncated ? " …" : ""}`,
        width,
        "    ",
        !plan.summary,
      ),
    );
  return lines.join("\n");
}

function releaseLine(release: OverviewRelease, options: TextOptions): string {
  const width = outputWidth(options);
  const readiness = release.readiness;
  const date =
    release.status === "released" && release.releasedAt
      ? `выпущен ${release.releasedAt}`
      : release.plannedFor
        ? `плановая дата ${release.plannedFor}`
        : "без плановой даты";
  return [
    indent(`${release.key} — ${release.title} · версия ${release.version}`, width),
    indent(`Статус: ${releaseStatuses[release.status]} · ${date}`, width, "    "),
    indent(
      readiness.total
        ? `Готовность состава: ${readiness.ready} из ${readiness.total} ${ofPlans(readiness.total)} (${readiness.percent}%)${
            readiness.missing ? ` · недоступно ${readiness.missing}` : ""
          } · ${
            readiness.ready === readiness.total && !readiness.missing
              ? "состав фактически готов"
              : "состав не готов"
          }${release.status === "planned" && readiness.canRelease ? " · можно выпускать" : ""}`
        : "Готовность состава: планов нет",
      width,
      "    ",
    ),
  ].join("\n");
}

const statusSplit = (counts: { none: number; partial: number; done: number }) =>
  `готово ${counts.done} · частично ${counts.partial} · не начато ${counts.none}`;

function passportText(
  data: ProductOverviewView,
  options: TextOptions,
): { title: string; fields: [string, string | number][]; body: string } {
  const passport = data.snapshot.passport;
  const width = outputWidth(options);
  if (passport.state === "missing")
    return {
      title: "Продукт без паспорта",
      fields: [["Паспорт", "ещё не создан"]],
      body: `${prose("Назначение продукта пока не описано. Поля и пример создания:", width)}\n${commandText(data.commands.passportHelp, options)}`,
    };
  const fields: [string, string | number][] = [
    ["Паспорт", passport.state === "filled" ? "заполнен" : "без краткого описания"],
    ["Ключ", passport.key ?? passport.id],
    ["Ревизия", passport.revision],
  ];
  const body =
    passport.state === "filled"
      ? prose(safeText(passport.summary), width)
      : passport.excerpt.text
        ? `${prose(
            `Краткое описание пустое. Начало описания паспорта${passport.excerpt.truncated ? " (фрагмент)" : ""}:`,
            width,
          )}\n${indent(passport.excerpt.text + (passport.excerpt.truncated ? " …" : ""), width, "  ", true)}`
        : prose("Краткое описание и полное описание паспорта пусты.", width);
  return { title: `Продукт · ${passport.name}`, fields, body };
}

/**
 * Обзор для человека и агента: сначала контекст и сводка, затем внимание, планы и релизы,
 * знания и документы, в конце — страница прежней карты и адресные команды чтения.
 */
export function productOverviewText(
  data: ProductOverviewView,
  options: TextOptions,
  offset = 0,
): string {
  const snapshot = data.snapshot;
  const width = outputWidth(options);
  const commands = data.commands;
  const passport = passportText(data, options);
  const tasks = snapshot.tasks;
  const columns = tasks.byColumn;
  const knowledge = snapshot.knowledge;
  const documents = snapshot.documents;
  const plans = snapshot.plans;
  const releases = snapshot.releases;

  const head = cardText(
    {
      title: passport.title,
      fields: [
        ["Проект", `${snapshot.project.name} (${snapshot.project.slug})`],
        ["ID проекта", snapshot.project.id ?? "не назначен"],
        ["Срез получен", data.generatedAt],
        ...passport.fields,
      ],
      sections: [{ title: "Паспорт", body: passport.body }],
    },
    options,
  );

  const summary = cardText(
    {
      title: "Сводка",
      fields: [
        ["Задач всего", tasks.total],
        [
          "По колонкам",
          `inbox ${columns.inbox} · ready ${columns.ready} · in-progress ${columns["in-progress"]} · review ${columns.review} · done ${columns.done} · cancelled ${columns.cancelled}`,
        ],
        [
          "Фактически выполнено",
          `${tasks.completed}${tasks.doneWithOpenObligations ? ` · в done с невыполненными обязательствами ${tasks.doneWithOpenObligations}` : ""}`,
        ],
        ["Готовы к началу", tasks.readyToStart],
        ["Заблокировано", tasks.blocked],
        [
          "Критерии приёмки",
          tasks.criteria.total
            ? `выполнено ${tasks.criteria.completed} из ${tasks.criteria.total} · не выполнено ${tasks.criteria.pending} в ${tasks.criteria.tasksWithPending} ${plural(tasks.criteria.tasksWithPending, ["задаче", "задачах", "задачах"])}`
            : "нет",
        ],
        [
          "Доски",
          `${snapshot.boards.total} (продукт ${snapshot.boards.byKind.product} · приложения ${snapshot.boards.byKind.application} · инфраструктура ${snapshot.boards.byKind.infrastructure})`,
        ],
      ],
    },
    options,
  );
  const overlap = prose(
    "Выполненные, готовые к началу, заблокированные и критерии пересекаются с колонками и не складываются в общее число.",
    width,
  );

  const attention = [
    prose("Требует внимания", width),
    previewBlock(
      "В работе",
      snapshot.attention.inProgress,
      (task) => taskLine(task, options),
      "Задач в работе нет.",
      commands.inProgress,
      options,
    ),
    previewBlock(
      "На проверке",
      snapshot.attention.review,
      (task) => taskLine(task, options),
      "Задач на проверке нет.",
      commands.review,
      options,
    ),
    previewBlock(
      "Заблокированы",
      snapshot.attention.blocked,
      (task) => taskLine(task, options),
      "Заблокированных задач нет.",
      commands.blocked,
      options,
    ),
  ].join("\n\n");

  const planning = [
    cardText(
      {
        title: "Планы",
        fields: [
          [
            "Всего",
            `${plans.total} (черновики ${plans.byStatus.draft} · в работе ${plans.byStatus.active} · завершены ${plans.byStatus.completed} · отменены ${plans.byStatus.cancelled})`,
          ],
          ...(plans.completedNotReady
            ? ([["Завершены по статусу, но состав не выполнен", plans.completedNotReady]] as const)
            : []),
        ],
      },
      options,
    ),
    previewBlock(
      "Активные планы",
      plans.active,
      (plan) => planLine(plan, options),
      plans.total ? "Активных планов нет. Все планы:" : "Планов пока нет.",
      commands.activePlans,
      options,
      plans.total ? commands.plans : undefined,
    ),
    cardText(
      {
        title: "Релизы",
        fields: [
          [
            "Всего",
            `${releases.total} (запланированы ${releases.byStatus.planned} · выпущены ${releases.byStatus.released} · отменены ${releases.byStatus.cancelled})`,
          ],
        ],
      },
      options,
    ),
    previewBlock(
      "Ближайшие запланированные",
      releases.upcoming,
      (release) => releaseLine(release, options),
      "Запланированных релизов нет.",
      commands.plannedReleases,
      options,
    ),
    previewBlock(
      "Последние выпущенные",
      releases.recent,
      (release) => releaseLine(release, options),
      "Выпущенных релизов нет.",
      commands.releasedReleases,
      options,
    ),
    prose(
      "Собственный статус плана или релиза не равен фактической готовности состава: она считается по задачам.",
      width,
    ),
  ].join("\n\n");

  const implementations = (entry: Snapshot["knowledge"]["featureImplementations"]) =>
    `действующих ${entry.active} (${statusSplit(entry.byStatus)})${entry.withdrawn ? ` · снято ${entry.withdrawn}` : ""}`;
  const knowledgeText = cardText(
    {
      title: "Продуктовые знания",
      fields: [
        ["Фичи", `${knowledge.features.total} (${statusSplit(knowledge.features.byStatus)})`],
        ["Сценарии", `${knowledge.scenarios.total} (${statusSplit(knowledge.scenarios.byStatus)})`],
        [
          "Приложения",
          `${knowledge.applications.total} (фронтенд ${knowledge.applications.byType.frontend} · бэкенд ${knowledge.applications.byType.backend} · внутренние ${knowledge.applications.byType.internal})`,
        ],
        ["Реализации фич", implementations(knowledge.featureImplementations)],
        ["Реализации сценариев", implementations(knowledge.scenarioImplementations)],
      ],
    },
    options,
  );
  const boards = previewBlock(
    "Доски",
    snapshot.boards.catalog,
    (board) =>
      indent(
        `${board.prefix} — ${board.name} · задач ${board.tasks.total}, открытых ${board.tasks.open}`,
        width,
      ),
    "Досок нет.",
    commands.boards,
    options,
  );
  const documentsText = [
    cardText(
      {
        title: "Документы",
        fields: [
          [
            "Всего",
            `${documents.total} (черновики ${documents.byStatus.draft} · действующие ${documents.byStatus.active} · архивные ${documents.byStatus.archived})`,
          ],
          ["Закреплено", documents.pinned],
          [
            "Разделы",
            `${documents.sections.total}${documents.sections.unsectioned ? ` · без раздела ${documents.sections.unsectioned} док.` : ""}`,
          ],
        ],
      },
      options,
    ),
    previewBlock(
      "Закреплённые действующие",
      documents.pinnedActive,
      (document) =>
        [
          indent(`${document.key ?? document.id} — ${document.name}`, width),
          indent(
            [document.documentKind, document.summary].filter(Boolean).join(" · "),
            width,
            "    ",
          ),
        ].join("\n"),
      "Закреплённых действующих документов нет.",
      commands.pinnedDocuments,
      options,
    ),
  ].join("\n\n");

  const shownFrom = data.items.length ? offset + 1 : 0;
  const map = [
    prose(
      `Карта продукта · записи ${shownFrom}–${offset + data.items.length} из ${data.total}`,
      width,
    ),
    prose(
      `Готовых фич и сценариев: ${data.readinessCounts.ready} из ${data.readinessCounts.total} · требуют переподтверждения: ${data.readinessCounts.stale}`,
      width,
    ),
    listing(
      data.items,
      options,
      data.readiness,
      "",
      data.total ? "На этой странице записей нет." : "Записей продукта пока нет.",
    ),
    prose(`Версия для изменения состава: ${data.version}`, width),
  ].join("\n\n");

  const next = cardText(
    {
      title: "Дальнейшее чтение",
      commands: [
        { label: "Паспорт целиком", command: commands.passport },
        { label: "Готовность фич", command: commands.progress },
        { label: "Задачи в работе", command: commands.inProgress },
        { label: "Задачи на проверке", command: commands.review },
        { label: "Заблокированные задачи", command: commands.blocked },
        { label: "Готовые к началу", command: commands.readyToStart },
        { label: "Планы", command: commands.plans },
        { label: "Релизы", command: commands.releases },
        { label: "Документы", command: commands.documents },
        { label: "Доски", command: commands.boards },
      ],
    },
    options,
  );

  return [
    head,
    summary,
    overlap,
    attention,
    planning,
    knowledgeText,
    boards,
    documentsText,
    map,
    next,
  ]
    .filter(Boolean)
    .join(`\n\n`);
}

/** Компактные цели для выбора связи; полное описание читается отдельной командой get. */
export function productEntitiesText(
  data: { items: ProductEntitySummary[]; total: number; nextOffset: number | null },
  _query: ProductEntitiesQuery,
  options: TextOptions,
): string {
  const items = data.items.map((entry) => ({
    id: entry.id,
    ...(entry.key ? { key: entry.key } : {}),
    revision: entry.revision,
    kind: entry.kind,
    name: entry.title,
    summary: [
      entry.applicationName,
      entry.targetKey,
      entry.targetName,
      entry.summary,
      entry.active ? "" : "Участие снято",
    ]
      .filter(Boolean)
      .join(" · "),
  }));
  return [
    section(
      `Продуктовые цели · ${items.length} из ${data.total}`,
      listing(items, options),
      options,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function productContextText(data: ProductContext, options: TextOptions): string {
  const sections = [
    section("Контекст продукта", `Включено записей: ${data.records.length}`, options),
  ];
  for (const { record, reasons } of data.records)
    sections.push(
      [
        productRecordText(record, options),
        section("Почему включено", wrap(safeText(reasons.join("; ")), options.width), options),
        ...data.readiness
          .filter((entry) => entry.id === record.id)
          .map((entry) =>
            wrap(
              `Готовность: ${statuses[entry.status]} · участников ${entry.participants} · готово ${entry.completed} · устарело ${entry.stale}`,
              options.width,
            ),
          ),
      ].join("\n\n"),
    );
  if (!data.records.length)
    sections.push(
      "Связанного контекста пока нет. Посмотрите npx @oim-dev/relay-cli product overview или выберите --id.",
    );
  return sections.join(`\n\n${"─".repeat(options.width)}\n\n`);
}

export function productStateText(data: ProductState, options: TextOptions): string {
  return section(
    "Снимок продукта",
    data.records.map((record) => productRecordText(record, options)).join("\n\n") ||
      "Продукт пока пуст.",
    options,
  );
}

export function productSavedText(
  command: ProductMutation,
  result: { id: string; key?: string | undefined; revision: number },
  options: TextOptions,
): string {
  const fields = command.fields;
  return section(
    command.action === "create" ? "Запись создана" : "Запись сохранена",
    wrap(
      [
        `${kinds[fields.kind]}${"name" in fields ? ` · ${safeText(fields.name)}` : ""}`,
        ...(result.key ? [`Ключ: ${result.key}`] : []),
        `ID: ${result.id}`,
        `Ревизия: ${result.revision}`,
        `Идентификатор запроса: ${safeText(command.requestId)}`,
      ].join("\n"),
      options.width,
    ),
    options,
  );
}

export function productLintText(
  data: { records: number; warnings: ContentWarning[]; total: number; nextOffset: number | null },
  options: TextOptions,
  _query: ProductContentQuery = {},
  keys: ReadonlyMap<string, string> = new Map(),
): string {
  return [
    listText(
      {
        title: "Качество содержания",
        filters: [["Проверено записей", data.records], ...filterFields(_query)],
        items: data.warnings.map((entry) => ({
          key: keys.get(entry.id) ?? entry.id,
          title: entry.name,
          details: [`${entry.field}: ${entry.message}`],
        })),
        emptyMessage:
          data.total === 0 ? "Структурных замечаний нет." : "На этой странице замечаний нет.",
      },
      options,
    ),
    "Это структурная подсказка, а не подтверждение полноты требований.",
  ].join("\n\n");
}
