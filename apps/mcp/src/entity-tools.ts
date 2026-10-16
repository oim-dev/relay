import { z } from "zod";
import {
  entityPageQuerySchema,
  entityTypeQuerySchema,
  entitiesQuerySchema,
  entityGetQuerySchema,
  entityKeysQuerySchema,
  entityKeySpacesQuerySchema,
  entityCreateDataSchemas,
  entityUpdateDataSchemas,
  entityCreateSchema,
  entityUpdateSchema,
  entityRenameSchema,
  entityMoveTaskSchema,
  entityLinkTaskSchema,
} from "@relay/contracts/entities";
import type { EntitySaved } from "@relay/contracts/entities";
import { actorSchema, entityReferenceSchema, requestIdSchema } from "@relay/contracts/primitives";
import { fullContextQuerySchema } from "@relay/contracts/entities/graph";
import {
  documentBulkSchema,
  documentFacetsQuerySchema,
  documentRelationChangeSchema,
  entityDocumentsQuerySchema,
} from "@relay/contracts/entities/document-catalog";
import type { DocumentBulkResult } from "@relay/contracts/entities/document-catalog";
import type { Backend } from "@relay/project-runtime/backend/types";
import type { Result } from "./output.js";

type EntityTool = {
  name: string;
  description: string;
  schema: z.ZodObject;
  readOnly: boolean;
  run: (backend: Backend, input: Record<string, unknown>) => Promise<Result>;
};
const saved = (data: EntitySaved): Result => ({
  data,
  text: `${data.key}: ${data.action}. Вид: ${data.ref.kind}. ID: ${data.ref.id}. Ревизия: ${data.revision}. requestId: ${data.requestId}.`,
});
const write = { actor: actorSchema, requestId: requestIdSchema };

/** Поэлементная квитанция массовой операции: текст перечисляет каждый элемент без сокращения. */
const bulkReceipt = (data: DocumentBulkResult): Result => ({
  data,
  text: [
    `Массовая операция над материалами: сохранено ${data.applied}, отказов ${data.failed}, всего ${data.items.length}. requestId: ${data.requestId}.`,
    ...data.items.map(
      (item) =>
        `- ${item.ref}: ${item.status}${item.key ? `; ключ ${item.key}` : ""}${item.revision === undefined ? "" : `; ревизия ${item.revision}`}${item.error ? `; ${item.error.code}: ${item.error.message}` : ""}`,
    ),
    data.failed
      ? "Набор не атомарен и не повторяется автоматически: сохранённые элементы остаются. Перечитайте материалы с отказом; при conflict сверьте актуальное содержание и решите, нужно ли новое действие только для них."
      : "Все элементы обработаны.",
  ].join("\n"),
});

/** Описания уточняют смысл общих фильтров для каталога материалов; валидация не меняется. */
const documentFacetsInputSchema = documentFacetsQuerySchema.extend({
  q: documentFacetsQuerySchema.shape.q.describe(
    "Поиск по ключу, названию, краткому описанию, содержанию, адресу ссылки и тегам материала",
  ),
  status: documentFacetsQuerySchema.shape.status.describe(
    "Состояние материала: draft, active или archived",
  ),
});

/** Отдельные действия каталога материалов; правила формата, тегов и связей проверяет Core. */
const documentTools: EntityTool[] = [
  {
    name: "entity_document_facets",
    description:
      "Счётчики каталога материалов по полным данным проекта: разделы, теги, форматы, типы, состояния и системные представления. Фильтры как у entities_list; каждая ось считается без собственного фильтра, теги — с учётом уже выбранных. version совпадает с версией списка",
    schema: documentFacetsInputSchema,
    readOnly: true,
    run: async (backend, input) => ({
      data: await backend.entities.documentFacets(documentFacetsQuerySchema.parse(input)),
    }),
  },
  {
    name: "entity_documents_list",
    description:
      "Материалы, прикреплённые непосредственно к сущности любого из 11 видов, со всеми связями с ней: тип, пояснение и источник (relations или совместимые links). Материалы родителя и детей не включаются; архивные включены с отметкой. Продолжение по nextOffset/version; полный текст читайте через entity_get",
    schema: entityDocumentsQuerySchema,
    readOnly: true,
    run: async (backend, input) => ({
      data: await backend.entities.entityDocuments(entityDocumentsQuerySchema.parse(input)),
    }),
  },
  {
    name: "entity_document_bulk",
    description:
      "Одно действие для 1–100 материалов: переместить в раздел, добавить или снять теги, изменить состояние, закрепить или открепить. Каждый материал передаётся со своей прочитанной ревизией и сохраняется отдельно; набор не атомарен, прикрепления не меняются. Ответ — поэлементная квитанция applied/unchanged/conflict/not_found/invalid/error; при частичном отказе вызов успешен, перечитайте только элементы с отказом.",
    schema: documentBulkSchema.extend({ actor: actorSchema }),
    readOnly: false,
    run: async (backend, input) =>
      bulkReceipt(
        await backend.entities.documentBulk(
          documentBulkSchema.parse(input),
          actorSchema.parse(input.actor),
        ),
      ),
  },
  {
    name: "entity_document_relate",
    description:
      "Прикрепить, изменить или открепить одну связь материала с сущностью проекта под ревизией материала; прочие relations и совместимые links сохраняются. attach повтора цели и типа даёт ALREADY_EXISTS, отсутствующая связь — RELATION_NOT_FOUND, устаревшая ревизия — REVISION_CONFLICT. target принимает ключ, ID или kind:ID.",
    schema: documentRelationChangeSchema.extend({ actor: actorSchema }),
    readOnly: false,
    run: async (backend, input) =>
      saved(
        await backend.entities.relateDocument(
          documentRelationChangeSchema.parse(input),
          actorSchema.parse(input.actor),
        ),
      ),
  },
];

/** Аргументы инструментов выводятся из контрактов видов и остаются на верхнем уровне. */
export const entityTools: EntityTool[] = [
  {
    name: "entity_types",
    description: "Перечислить основные виды сущностей, их назначение, действия и фильтры",
    schema: entityPageQuerySchema,
    readOnly: true,
    run: async (backend, input) => ({
      data: await backend.entities.types(entityPageQuerySchema.parse(input)),
    }),
  },
  {
    name: "entity_type_get",
    description: "Прочитать контракт вида: поля, схемы создания/изменения и правила ключей",
    schema: entityTypeQuerySchema,
    readOnly: true,
    run: async (backend, input) => ({
      data: await backend.entities.describe(entityTypeQuerySchema.parse(input)),
    }),
  },
  {
    name: "entities_list",
    description:
      "Найти сущности по виду, ключу, доске, приложению и другим объявленным фильтрам; для материалов (kind=document) также раздел, формат, теги (все выбранные), тип, состояние, закрепление и признак без прикреплений. Продолжение по nextOffset/version",
    schema: entitiesQuerySchema,
    readOnly: true,
    run: async (backend, input) => ({
      data: await backend.entities.list(entitiesQuerySchema.parse(input)),
    }),
  },
  {
    name: "entity_get",
    description: "Прочитать полные типизированные данные сущности по читаемому ключу либо ID",
    schema: entityGetQuerySchema,
    readOnly: true,
    run: async (backend, input) => {
      const data = await backend.entities.get(entityGetQuerySchema.parse(input));
      return {
        data,
        text: `${data.key} — ${data.title}\nВид: ${data.ref.kind}. Ревизия: ${data.revision}.${data.document ? ` Документ: ${data.document.kind}; состояние: ${data.document.status}.` : ""} Полные данные доступны в structuredContent.`,
      };
    },
  },
  {
    name: "entity_resolve",
    description:
      "Найти постоянный адрес и текущий ключ по ключу, алиасу или ID; обычно отдельный вызов не требуется",
    schema: entityGetQuerySchema,
    readOnly: true,
    run: async (backend, input) => ({
      data: await backend.entities.resolve(entityGetQuerySchema.parse(input)),
    }),
  },
  {
    name: "entity_keys",
    description: "Прочитать текущий и прежние ключи сущности с постраничным продолжением",
    schema: entityKeysQuerySchema,
    readOnly: true,
    run: async (backend, input) => ({
      data: await backend.entities.keys(entityKeysQuerySchema.parse(input)),
    }),
  },
  {
    name: "entity_key_spaces",
    description:
      "Перечислить актуальные области нумерации, доски и префиксы ключей выбранного вида",
    schema: entityKeySpacesQuerySchema,
    readOnly: true,
    run: async (backend, input) => ({
      data: await backend.entities.keySpaces(entityKeySpacesQuerySchema.parse(input)),
    }),
  },
  {
    name: "entity_context",
    description:
      "Получить полный контекст сущности одним вызовом: все узлы и сохранённые рёбра достижимой компоненты в обоих направлениях, включая циклы. Успех всегда complete=true; при превышении maxBytes возвращается ошибка, усечённого графа нет",
    schema: z.strictObject({ ref: fullContextQuerySchema.shape.root }),
    readOnly: true,
    run: async (backend, input) => {
      return {
        data: await backend.graph.context(fullContextQuerySchema.parse({ root: input.ref })),
      };
    },
  },
  {
    name: "entity_rename_key",
    description:
      "Изменить читаемый ключ сущности, сохранив ID, отношения и прежние алиасы; требуется прочитанная ревизия",
    schema: entityRenameSchema.extend({ actor: actorSchema }),
    readOnly: false,
    run: async (backend, input) => {
      const command = entityRenameSchema.parse(input);
      return saved(await backend.entities.rename(command, actorSchema.parse(input.actor)));
    },
  },
  {
    name: "entity_task_move",
    description:
      "Переместить задачу в колонку или на доску; все ссылки принимают ключи или ID, блокеры проверяет Core",
    schema: entityMoveTaskSchema.extend({ actor: actorSchema }),
    readOnly: false,
    run: async (backend, input) => {
      const command = entityMoveTaskSchema.parse(input);
      return saved(await backend.entities.moveTask(command, actorSchema.parse(input.actor)));
    },
  },
  {
    name: "entity_task_link",
    description:
      "Установить или снять зависимость, родительство либо контекстную связь задач по ключам или ID",
    schema: entityLinkTaskSchema.extend({ actor: actorSchema }),
    readOnly: false,
    run: async (backend, input) => {
      const command = entityLinkTaskSchema.parse(input);
      return saved(await backend.entities.linkTask(command, actorSchema.parse(input.actor)));
    },
  },
];

for (const [kind, schema] of Object.entries(entityCreateDataSchemas)) {
  const { kind: _kind, ...shape } = schema.shape;
  entityTools.push({
    name: `entity_${kind}_create`,
    description:
      kind === "document"
        ? "Создать материал библиотеки: формат markdown (непустой body) либо link (обязательный url http/https, body — необязательное пояснение), тип, состояние, раздел, теги и прикрепления. Без documentFormat материал создаётся как markdown. Правила формата, адреса и нормализацию тегов проверяет Core; связи сохраняются в той же операции. Ссылки targets принимают ключи или ID."
        : `Создать сущность ${kind} с продуктовыми линками. В едином хранилище бекенд сохраняет соответствующие связи Core в той же операции; старую базу предварительно переносят через storage migrate. Полные описания — Markdown; ссылки принимают ключи или ID.`,
    schema: z.strictObject({ ...shape, ...write }),
    readOnly: false,
    run: async (backend, input) => {
      const { actor, requestId, ...fields } = input;
      const command = entityCreateSchema.parse({ data: { ...fields, kind }, actor, requestId });
      return saved(await backend.entities.create(command, actorSchema.parse(actor)));
    },
  });
}
for (const [kind, schema] of Object.entries(entityUpdateDataSchemas)) {
  const { kind: _kind, ...shape } = schema.shape;
  entityTools.push({
    name: `entity_${kind}_update`,
    description:
      kind === "document"
        ? "Изменить материал по ключу или ID под прочитанной ревизией. Отсутствующие поля сохраняются; переданные tags, relations и targets заменяют набор целиком, [] очищает. Переход на documentFormat=link требует url, на markdown — снимает url и требует непустой body. Для одной связи используйте entity_document_relate, для группы материалов — entity_document_bulk."
        : `Изменить содержание и продуктовые линки сущности ${kind} по ключу или ID. Бекенд согласует соответствующие связи Core в едином хранилище. Отсутствующие поля сохраняются, пустой массив снимает линки; требуются прочитанная ревизия и requestId для корреляции.`,
    schema: z.strictObject({
      ...shape,
      ...write,
      ref: entityReferenceSchema,
      ifRevision: entityUpdateSchema.shape.ifRevision,
    }),
    readOnly: false,
    run: async (backend, input) => {
      const { actor, requestId, ref, ifRevision, ...fields } = input;
      const command = entityUpdateSchema.parse({
        changes: { ...fields, kind },
        actor,
        requestId,
        ref,
        ifRevision,
      });
      return saved(await backend.entities.update(command, actorSchema.parse(actor)));
    },
  });
}
entityTools.push(...documentTools);
