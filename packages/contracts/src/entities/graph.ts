import { z } from "zod";
import {
  actorSchema,
  text,
  timestampSchema,
  requestIdSchema,
  entityReferenceSchema,
} from "../primitives.js";

const token = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const entityRefSchema = z.strictObject({
  kind: token.describe("Расширяемый вид сущности"),
  id: token.describe("Постоянный ID сущности в выбранном проекте"),
});
export const graphNodeSchema = z.strictObject({
  ref: entityRefSchema.describe("Адрес сущности"),
  title: z.string().describe("Однострочное название сущности"),
  key: z.string().describe("Читаемый ключ или ID"),
  revision: z.number().int().nonnegative().describe("Ревизия источника"),
  status: z.string().describe("Состояние источника, пустая строка если не применимо"),
});
export const graphEdgeSchema = z.strictObject({
  id: token.describe("Постоянный ID отношения"),
  type: token.describe("Расширяемый тип отношения, например references или contains"),
  from: entityRefSchema.describe("Начало отношения"),
  to: entityRefSchema.describe("Конец отношения"),
  description: text(64 * 1024).describe("Пояснение назначения связи в Markdown"),
  revision: z.number().int().positive().describe("Ревизия отношения"),
  source: z.literal("graph").describe("Единственный источник — явно сохранённая связь движка Core"),
  createdBy: actorSchema.describe("Автор установки связи"),
  createdAt: timestampSchema.describe("Время установки связи"),
});
export const graphQuerySchema = z.strictObject({
  root: z
    .string()
    .max(257)
    .optional()
    .describe("Ключ или ID корня; допустим kind:ID. Без корня весь граф проекта"),
  type: token.optional().describe("Оставить только отношения выбранного типа"),
  direction: z
    .enum(["both", "outgoing", "incoming"])
    .default("both")
    .describe("Направление обхода относительно каждого узла"),
  depth: z.coerce
    .number()
    .int()
    .min(0)
    .max(100)
    .default(3)
    .describe("Глубина одного обхода 0–100; продолжайте от граничных узлов"),
  profile: z
    .enum(["all", "context"])
    .default("all")
    .describe(
      "Полный обход сохранённых связей; context — совместимое имя all без скрытых ограничений по видам",
    ),
  q: z
    .string()
    .max(1024)
    .optional()
    .describe("Поиск узлов по ключу, адресу и названию; рёбра только между найденными узлами"),
  offset: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe("Смещение одновременно в списках узлов и рёбер"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(40)
    .describe("Размер каждой страницы узлов и рёбер, максимум 100"),
  version: z
    .string()
    .max(128)
    .optional()
    .describe("Версия первой страницы; изменение требует повторить чтение"),
});
export const graphPageSchema = z.strictObject({
  nodes: z.array(graphNodeSchema).describe("Страница узлов, включая изолированные"),
  edges: z.array(graphEdgeSchema).describe("Страница рёбер"),
  endpoints: z
    .array(graphNodeSchema)
    .describe("Карточки концов рёбер этой страницы для независимого рендера"),
  paths: z
    .array(
      z.strictObject({
        target: entityRefSchema.describe("Узел страницы"),
        nodes: z.array(entityRefSchema).describe("Один кратчайший объясняющий путь от корня"),
        edges: z.array(z.string()).describe("ID отношений пути; не все возможные пути"),
        keys: z.array(z.string()).optional().describe("Читаемые ключи узлов пути в том же порядке"),
      }),
    )
    .describe("Причины включения узлов в обход"),
  totalNodes: z.number().int().nonnegative().describe("Число узлов выбранной области"),
  totalEdges: z.number().int().nonnegative().describe("Число отношений выбранной области"),
  nextOffset: z.number().nullable().describe("Продолжение обеих выборок, null в конце"),
  boundary: z
    .array(entityRefSchema)
    .describe("Узлы страницы с ещё не пройденными соседями из-за глубины"),
  depthLimited: z.boolean().describe("Есть непройденные узлы за границей глубины"),
  version: z.string().describe("Версия всего согласованного графа и карточек"),
});
const add = z.strictObject({
  action: z.literal("add").describe("Создать отношение"),
  type: token.describe("Тип создаваемого отношения; не ограничен предметными видами"),
  from: z
    .union([entityReferenceSchema, entityRefSchema])
    .describe("Ключ, ID или постоянный адрес начала связи"),
  to: z
    .union([entityReferenceSchema, entityRefSchema])
    .describe("Ключ, ID или постоянный адрес конца связи"),
  description: text(64 * 1024)
    .default("")
    .describe("Необязательное пояснение в Markdown"),
});
const update = z.strictObject({
  action: z.literal("update").describe("Изменить пояснение существующего отношения"),
  id: token.describe("ID редактируемого отношения"),
  description: text(64 * 1024).describe("Новое пояснение в Markdown"),
});
const remove = z.strictObject({
  action: z.literal("remove").describe("Отозвать отношение с сохранением истории"),
  id: token.describe("ID отзываемого отношения"),
});
export const graphMutationSchema = z.strictObject({
  operations: z
    .array(z.discriminatedUnion("action", [add, update, remove]))
    .min(1)
    .max(100)
    .describe("Атомарный пакет до 100 явных изменений"),
  ifVersion: z
    .string()
    .min(1)
    .max(128)
    .describe("Версия прочитанного графа; конфликт не теряет изменения"),
  requestId: requestIdSchema.describe("Ключ безопасного повтора всего пакета"),
  actor: actorSchema.optional().describe("Автор изменения"),
});
export const graphSavedSchema = z.strictObject({
  ids: z
    .array(z.string())
    .describe("ID созданных, изменённых и отозванных отношений в порядке операций"),
  revision: z.number().int().positive().describe("Ревизия хранилища отношений после пакета"),
  version: z.string().describe("Версия графа после записи"),
  requestId: z.string().describe("Ключ повтора; повтор возвращает первоначальную квитанцию"),
});
export type EntityRef = z.infer<typeof entityRefSchema>;
export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphEdge = z.infer<typeof graphEdgeSchema>;
export type GraphPage = z.infer<typeof graphPageSchema>;
export type GraphQuery = z.input<typeof graphQuerySchema>;
export type GraphMutation = z.input<typeof graphMutationSchema>;
export type GraphSaved = z.infer<typeof graphSavedSchema>;

/** Полный контекст — отдельный контракт; параметры страниц графа его не ограничивают. */
export const fullContextQuerySchema = z.strictObject({
  root: entityReferenceSchema.describe(
    "Ключ, ID или kind:ID исходной сущности; обход обоих направлений до конца компоненты",
  ),
});
export const fullContextSchema = z.strictObject({
  root: entityRefSchema.describe("Постоянный адрес исходной сущности"),
  version: z.string().describe("Версия согласованного снимка карточек и связей"),
  nodes: z.array(graphNodeSchema).describe("Все узлы достижимой компоненты"),
  edges: z
    .array(graphEdgeSchema.pick({ id: true, type: true, from: true, to: true, revision: true }))
    .describe("Все действующие рёбра, включая петли и параллельные отношения"),
  complete: z
    .literal(true)
    .describe("Успешный ответ всегда полный; превышение бюджета возвращает ошибку"),
});
export type FullContextQuery = z.infer<typeof fullContextQuerySchema>;
export type FullContext = z.infer<typeof fullContextSchema>;

/** Канонический адрес узла без зависимости от его вида. */
export function entityAddress(ref: EntityRef): string {
  return `${ref.kind}:${ref.id}`;
}
