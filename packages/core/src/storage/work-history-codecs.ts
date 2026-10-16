import { z } from "zod";
import {
  agentRunSchema,
  agentRunSummarySchema,
  workCheckpointSchema,
  workSessionSchema,
  workSessionSummarySchema,
} from "@relay/contracts/work-history";
import type { JsonValue } from "@relay/contracts/storage";
import { invariant } from "../shared/errors.js";
import { markdownCodec } from "./entity-store/codecs.js";
import type { EntityCodec, EntityRecord } from "./entity-store/registry.js";
import type { EntityReference } from "./entity-store/references.js";
import {
  agentRunV1,
  workCheckpointV1,
  workSessionV1,
} from "./data-model/history/work-history-v1.js";

const sessionMarkdown = markdownCodec([["description"], ["result"]]);
const runMarkdown = markdownCodec([["reason"]]);
const endedRunMarkdown = markdownCodec([["reason"], ["endSummary"]]);
const checkpointMarkdown = markdownCodec([
  ["body"],
  ["done"],
  ["remaining"],
  ["nextStep"],
  ["checks"],
]);
const runSummary = agentRunSummarySchema.strip();
const checkpointFields = {
  id: true,
  key: true,
  sessionId: true,
  runId: true,
  sequence: true,
  kind: true,
  intentId: true,
  title: true,
  createdAt: true,
  createdBy: true,
  acceptedSessionIds: true,
} as const;
const checkpointSummary = z.union(
  workCheckpointSchema.options.map((option) => option.pick(checkpointFields).strip()),
);
const json = (value: unknown) => z.json().parse(value);
const internal = (
  field: string,
  kind: string,
  id: JsonValue | undefined,
  inverse?: string,
): EntityReference => ({ field, kind, id, allowDeleted: false, ...(inverse ? { inverse } : {}) });

/** Собственные индексы технических владельцев; общие addresses/cards/graph не задействованы. */
function indexes(index: string, schema: z.ZodType) {
  return (record: EntityRecord) => {
    invariant(
      record.data.id === record.id,
      "INVALID_DATA",
      "ID данных истории не совпадает с оболочкой",
      5,
    );
    if (record.kind === "work-session")
      invariant(
        record.data.revision === record.revision,
        "INVALID_DATA",
        "Ревизия ветки не совпадает с оболочкой",
        5,
      );
    return [
      { index, key: record.id, value: json(schema.parse(record.data)) },
      {
        index: "work-history-addresses",
        key: `${record.kind}:${String(record.data.key)}`,
        value: record.id,
      },
    ];
  };
}

/** Три технических владельца профиля 3: полный публичный DTO в data, оболочка key:null. */
export function workHistoryCodecs(): EntityCodec[] {
  return [
    {
      kind: "work-session",
      collection: "work-sessions",
      dataVersion: 1,
      addressable: false,
      schema: workSessionSchema,
      diskSchema: workSessionV1,
      encode: (data) =>
        json(workSessionV1.parse(sessionMarkdown.encode(data))) as Record<string, JsonValue>,
      decode: (data) => sessionMarkdown.decode(workSessionV1.parse(data)),
      indexes: indexes("work-history-sessions", workSessionSummarySchema.strip()),
      references: (data) => [
        internal("parentSessionId", "work-session", data.parentSessionId),
        internal("originCheckpointId", "work-checkpoint", data.originCheckpointId),
        internal("createdByRunId", "agent-run", data.createdByRunId),
        internal("currentRunId", "agent-run", data.currentRunId, "sessionId"),
      ],
      card: () => ({ title: "Ветка работы", status: "", selectors: [] }),
    },
    {
      kind: "agent-run",
      collection: "agent-runs",
      dataVersion: 1,
      addressable: false,
      schema: agentRunSchema,
      diskSchema: agentRunV1,
      encode: (data) =>
        json(
          agentRunV1.parse(
            (data.endSummary === null ? runMarkdown : endedRunMarkdown).encode(data),
          ),
        ) as Record<string, JsonValue>,
      decode: (data) =>
        (data.endSummary === null ? runMarkdown : endedRunMarkdown).decode(agentRunV1.parse(data)),
      indexes: indexes("work-history-runs", runSummary),
      references: (data) => [
        internal("sessionId", "work-session", data.sessionId),
        internal("predecessorRunId", "agent-run", data.predecessorRunId),
      ],
      card: () => ({ title: "Участие агента", status: "", selectors: [] }),
    },
    {
      kind: "work-checkpoint",
      collection: "work-checkpoints",
      dataVersion: 1,
      addressable: false,
      schema: workCheckpointSchema,
      diskSchema: workCheckpointV1,
      encode: (data) =>
        json(workCheckpointV1.parse(checkpointMarkdown.encode(data))) as Record<string, JsonValue>,
      decode: (data) => checkpointMarkdown.decode(workCheckpointV1.parse(data)),
      indexes: indexes("work-history-checkpoints", checkpointSummary),
      references: (data) => [
        internal("sessionId", "work-session", data.sessionId),
        internal("runId", "agent-run", data.runId),
        internal("intentId", "work-checkpoint", data.intentId),
        ...(Array.isArray(data.acceptedSessionIds) ? data.acceptedSessionIds : []).map((id) =>
          internal("acceptedSessionIds", "work-session", id),
        ),
        // Подпись — сохранённый факт: надгробие допустимо и не заменяет key/title.
        ...(Array.isArray(data.references) ? data.references : []).map((entry, index) => {
          const ref = (entry as { ref: { kind: string; id: string } }).ref;
          return { field: `references.${index}.ref`, kind: ref.kind, id: ref.id };
        }),
      ],
      card: () => ({ title: "Точка работы", status: "", selectors: [] }),
    },
  ];
}
