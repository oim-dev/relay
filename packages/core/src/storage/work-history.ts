import { z } from "zod";
import {
  agentRunSchema,
  agentRunSummarySchema,
  workCheckpointSchema,
  workHistoryIdSchema,
  workSessionSchema,
  workSessionSummarySchema,
} from "@relay/contracts/work-history";
import type { AgentRun, WorkCheckpoint, WorkSession } from "@relay/contracts/work-history";
import { parse } from "../domain/validation.js";
import { invariant } from "../shared/errors.js";
import { shortId } from "../shared/ids.js";
import type { StorageSession } from "./entity-store/store.js";
import type { EntityRecord } from "./entity-store/registry.js";

const runCardSchema = agentRunSummarySchema;
const checkpointCardSchema = z.strictObject({
  ...workCheckpointSchema.options[0].pick({
    id: true,
    key: true,
    sessionId: true,
    runId: true,
    sequence: true,
    title: true,
    createdAt: true,
    createdBy: true,
  }).shape,
  kind: z.enum(["intent", "progress", "result", "cancel"]),
  intentId: workHistoryIdSchema.nullable(),
  acceptedSessionIds: z.array(workHistoryIdSchema),
});
export type CheckpointCard = z.output<typeof checkpointCardSchema>;
type Data = {
  "work-session": WorkSession;
  "agent-run": AgentRun;
  "work-checkpoint": WorkCheckpoint;
};
type Kind = keyof Data;
const indexes = {
  "work-session": "work-history-sessions",
  "agent-run": "work-history-runs",
  "work-checkpoint": "work-history-checkpoints",
} as const;
const schemas: { [K in Kind]: z.ZodType<Data[K]> } = {
  "work-session": workSessionSchema,
  "agent-run": agentRunSchema,
  "work-checkpoint": workCheckpointSchema,
};
const cardSchemas = {
  "work-session": workSessionSummarySchema,
  "agent-run": runCardSchema,
  "work-checkpoint": checkpointCardSchema,
};
const recordIndexSchema = z.object({
  ref: z.object({ kind: z.string(), id: z.string() }),
  deleted: z.boolean(),
});

/** Предметный адаптер использует общую сессию и её WAL, не отдельное хранилище. */
export class WorkHistoryRepository {
  constructor(readonly storage: StorageSession) {}

  private async cards<T extends { id: string; key: string }>(kind: Kind, schema: z.ZodType<T>) {
    const name = indexes[kind];
    const result: T[] = [];
    for (const [id, raw] of await this.storage.indexEntries(name)) {
      const card = parse(schema, raw, name, true);
      invariant(
        id === card.id,
        "STORAGE_INDEX_CORRUPT",
        "ID карточки истории не соответствует индексу",
        5,
      );
      result.push(card);
    }
    // Проверяется полный состав, а не только пустой корень: старый непустой индекс
    // тоже может потерять terminal-точку. Все проверки используют компактные данные,
    // включая подготовленные изменения текущей сессии, без открытия чужих Markdown.
    const records = await this.storage.indexEntries("records");
    invariant(records.length > 0, "STORAGE_INDEX_CORRUPT", "Потерян реестр записей", 5);
    const expected = new Set<string>();
    for (const [address, raw] of records) {
      const record = parse(recordIndexSchema, raw, "реестр записей", true);
      if (record.ref.kind !== kind || record.deleted) continue;
      invariant(
        address === `${kind}:${record.ref.id}`,
        "STORAGE_INDEX_CORRUPT",
        "Адрес истории не соответствует реестру записей",
        5,
      );
      expected.add(record.ref.id);
    }
    invariant(
      expected.size === result.length && result.every((card) => expected.has(card.id)),
      "STORAGE_INDEX_CORRUPT",
      `Состав индекса ${name} не соответствует реестру записей; выполните storage reindex`,
      5,
      { index: name, expected: expected.size, actual: result.length },
    );
    const addresses = new Map(
      (await this.storage.indexEntries("work-history-addresses")).filter(([key]) =>
        key.startsWith(`${kind}:`),
      ),
    );
    invariant(
      addresses.size === result.length &&
        result.every((card) => addresses.get(`${kind}:${card.key}`) === card.id),
      "STORAGE_INDEX_CORRUPT",
      "Адресный индекс истории не соответствует карточкам; выполните storage reindex",
      5,
      { index: "work-history-addresses", kind },
    );
    return result.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  sessions() {
    return this.cards("work-session", workSessionSummarySchema);
  }
  runs() {
    return this.cards("agent-run", runCardSchema);
  }
  checkpoints() {
    return this.cards("work-checkpoint", checkpointCardSchema);
  }

  async resolve(kind: Kind, reference: string): Promise<string> {
    const parts = reference.split(":");
    invariant(parts.length <= 2, "INVALID_REFERENCE", "Ожидается ключ, ID или kind:ID", 4);
    invariant(
      parts.length === 1 || parts[0] === kind,
      "ENTITY_KIND_MISMATCH",
      "Вид ссылки не соответствует действию",
      4,
    );
    const value = parts.at(-1)!;
    // Нельзя возвращать «не найдено», пока не подтверждён состав обоих индексов.
    const cards = await this.cards<{ id: string; key: string }>(kind, cardSchemas[kind]);
    const direct = cards.find((card) => card.id === value);
    const address =
      direct === undefined
        ? await this.storage.indexGet("work-history-addresses", `${kind}:${value}`)
        : direct.id;
    invariant(
      address !== undefined,
      "ENTITY_NOT_FOUND",
      `Запись истории ${reference} не найдена`,
      3,
    );
    const id = parse(workHistoryIdSchema, address, "адрес истории", true);
    const card = await this.storage.indexGet(indexes[kind], id);
    invariant(card !== undefined, "STORAGE_INDEX_CORRUPT", "Адрес истории потерял карточку", 5);
    return id;
  }

  async get<K extends Kind>(kind: K, id: string): Promise<Data[K]> {
    const record = await this.storage.get({ kind, id });
    const data = parse(schemas[kind], record.data, `${kind}:${id}`, true);
    invariant(
      data.id === id &&
        record.key === null &&
        (kind !== "work-session" || (data as WorkSession).revision === record.revision),
      "INVALID_DATA",
      "Оболочка и содержание истории не согласованы",
      5,
    );
    const raw = await this.storage.indexGet(indexes[kind], id);
    const schema =
      kind === "work-session"
        ? workSessionSummarySchema
        : kind === "agent-run"
          ? runCardSchema
          : checkpointCardSchema;
    // pick/omit строгие: сравниваем только поля соответствующей компактной карточки.
    const expected = Object.fromEntries(
      Object.keys(schema.shape).map((key) => [key, record.data[key]]),
    );
    invariant(
      JSON.stringify(parse<unknown>(schema, raw, "карточка истории", true)) ===
        JSON.stringify(parse<unknown>(schema, expected, "проекция истории", true)),
      "STORAGE_INDEX_STALE",
      "Карточка истории не соответствует записи; выполните reindex",
      4,
    );
    return data;
  }

  async identity(kind: Kind) {
    const prefix = kind === "work-session" ? "S" : kind === "agent-run" ? "RUN" : "CP";
    // Общий короткий ID; занятые ID и собственные ключи проверяются под замком записи.
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = shortId();
      const key = `${prefix}-${id}`;
      if (
        (await this.storage.indexGet("records", `${kind}:${id}`)) === undefined &&
        (await this.storage.indexGet(indexes[kind], id)) === undefined &&
        (await this.storage.indexGet("work-history-addresses", `${kind}:${key}`)) === undefined
      )
        return { id, key };
    }
    invariant(
      false,
      "WORK_HISTORY_KEY_CONFLICT",
      "Не удалось выделить свободный адрес истории; запись не выполнена",
      4,
    );
  }

  async put<K extends Kind>(kind: K, data: Data[K], actor: string, previous?: EntityRecord) {
    const at =
      "updatedAt" in data
        ? data.updatedAt
        : "createdAt" in data
          ? data.createdAt
          : (data.endedAt ?? data.startedAt);
    await this.storage.put(
      {
        schemaVersion: 3,
        kind,
        id: data.id,
        key: null,
        aliases: [],
        dataVersion: 1,
        revision: (previous?.revision ?? 0) + 1,
        createdAt: previous?.createdAt ?? at,
        createdBy: previous?.createdBy ?? actor,
        updatedAt: at,
        updatedBy: actor,
        data,
      },
      previous?.revision ?? null,
    );
  }

  async update<K extends "work-session" | "agent-run">(kind: K, data: Data[K], actor: string) {
    await this.put(kind, data, actor, await this.storage.get({ kind, id: data.id }));
  }
}
