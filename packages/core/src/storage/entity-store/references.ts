import type { JsonValue } from "@relay/contracts/storage";

/**
 * Предметные ссылки данных записи по постоянным ID. Владелец вида объявляет их в своём
 * кодеке (`EntityCodec.references`) по полям дисковой формы текущей версии; явное
 * обслуживание хранилища проверяет, что каждая ссылка указывает на существующую запись
 * вида (действующую или надгробие). `null` и отсутствующее поле — нет ссылки.
 */
export type EntityReference = {
  /** Поле данных (имя схемы, без пользовательского текста). */
  readonly field: string;
  readonly kind: string;
  readonly id: JsonValue | undefined;
  /**
   * Поле данных цели, которое обязано ссылаться обратно на источник (принадлежность
   * части целому); проверяется, если цель действующая.
   */
  readonly inverse?: string;
};
export type EntityReferences = (data: Record<string, JsonValue>) => readonly EntityReference[];

type Data = Record<string, JsonValue>;
const array = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);
const object = (value: JsonValue | undefined): Data =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
const ids = (field: string, kind: string, value: JsonValue | undefined): EntityReference[] =>
  array(value).map((id) => ({ field, kind, id }));

/** Ссылки `{ kind, id }` областей и целей; реализация дополнительно ссылается на приложение. */
export function targetReferences(
  field: string,
  value: JsonValue | undefined,
  kinds: readonly string[],
): EntityReference[] {
  return array(value).flatMap((item) => {
    const entry = object(item);
    const kind = typeof entry.kind === "string" ? entry.kind : "";
    if (!kinds.includes(kind)) return [];
    const refs: EntityReference[] = [{ field, kind, id: entry.id }];
    if (kind === "implementation" && entry.applicationId !== undefined)
      refs.push({ field: `${field}.applicationId`, kind: "application", id: entry.applicationId });
    return refs;
  });
}

const DOCUMENT_TARGETS = [
  "project",
  "product",
  "feature",
  "scenario",
  "application",
  "implementation",
  "board",
  "task",
  "document",
  "work-plan",
  "plan-stage",
  "release",
];

/** Ссылки встроенных видов по полям схем `@relay/contracts` (дисковая форма). */
export const BUILTIN_REFERENCES: Readonly<Record<string, EntityReferences>> = {
  task: (data) => [
    { field: "boardId", kind: "board", id: data.boardId },
    { field: "parentId", kind: "task", id: data.parentId },
    ...ids("dependencies", "task", data.dependencies),
    ...ids("related", "task", data.related),
    ...targetReferences("productLinks", data.productLinks, [
      "feature",
      "scenario",
      "implementation",
    ]),
  ],
  board: (data) => [{ field: "applicationId", kind: "application", id: data.applicationId }],
  scenario: (data) => [{ field: "featureId", kind: "feature", id: data.featureId }],
  implementation: (data) => [
    { field: "applicationId", kind: "application", id: data.applicationId },
    { field: "featureId", kind: "feature", id: data.featureId },
    { field: "scenarioId", kind: "scenario", id: data.scenarioId },
  ],
  document: (data) => [
    // У ссылки на продукт в `links` нет ID: продукт проекта единственный.
    ...targetReferences("links", data.links, [
      "feature",
      "scenario",
      "application",
      "implementation",
    ]),
    ...targetReferences(
      "relations.target",
      array(data.relations).map((item) => object(item).target ?? null),
      DOCUMENT_TARGETS,
    ),
  ],
  "work-plan": (data) => [
    { field: "projectId", kind: "project", id: data.projectId },
    ...array(data.stages).flatMap((stage) => ids("stages.taskIds", "task", object(stage).taskIds)),
    ...targetReferences("scope", data.scope, [
      "project",
      "product",
      "application",
      "feature",
      "scenario",
      "implementation",
    ]),
  ],
  release: (data) => [
    { field: "projectId", kind: "project", id: data.projectId },
    ...ids("planIds", "work-plan", data.planIds),
  ],
};
