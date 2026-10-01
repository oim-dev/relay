import { applyDecorators } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiQuery, ApiResponse } from "@nestjs/swagger";
import type { SchemaObject } from "@nestjs/swagger";
import { z } from "zod";
import { schemas } from "./schemas.js";
import type { SchemaName } from "./schemas.js";

export const ref = (name: SchemaName) => ({ $ref: `#/components/schemas/${name}` });

export function jsonSchema(schema: z.ZodType, io: "input" | "output" = "output"): SchemaObject {
  const { $schema, ...result } = z.toJSONSchema(schema, {
    target: "draft-7",
    io,
    override: ({ jsonSchema }) => {
      // Пустой tuple Zod выдаёт items: [], недопустимый в draft-7.
      // Запрет элементов сохраняет контракт пустого массива и в OpenAPI 3.1.
      if (Array.isArray(jsonSchema.items) && jsonSchema.items.length === 0) {
        jsonSchema.items = false;
        jsonSchema.maxItems = 0;
      }
    },
  });
  return result as SchemaObject;
}

/** Описываем настоящий JSON-конверт, а не только вложенный data. */
export function ApiEndpoint(options: {
  id: string;
  summary: string;
  response: SchemaName;
  status?: number;
  body?: SchemaName;
  query?: SchemaName;
  paged?: boolean;
}) {
  const decorators = [
    ApiOperation({
      operationId: options.id,
      summary: options.summary,
      description: options.summary,
    }),
    ApiResponse({
      status: options.status ?? 200,
      description: "Операция выполнена",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok", "data", ...(options.paged ? ["meta"] : [])],
        properties: {
          ok: { type: "boolean", enum: [true] },
          data: ref(options.response),
          ...(options.paged ? { meta: ref("PageMeta") } : {}),
        },
      },
    }),
    ...[400, 403, 404, 409, 500, ...(options.body ? [413, 415] : [])].map((status) =>
      ApiResponse({ status, description: errorDescriptions[status]!, schema: ref("ApiFailure") }),
    ),
  ];
  if (options.body) decorators.push(ApiBody({ required: true, schema: ref(options.body) }));
  if (options.query) {
    const query = jsonSchema(schemas[options.query], "input");
    for (const [name, schema] of Object.entries(query.properties ?? {}))
      decorators.push(
        ApiQuery({ name, required: query.required?.includes(name) ?? false, schema }),
      );
  }
  return applyDecorators(...decorators);
}

const errorDescriptions: Record<number, string> = {
  400: "Неверные аргументы: VALIDATION_ERROR, INVALID_ARGUMENT, INVALID_ID, INVALID_CURSOR, UNKNOWN_STATUS, UNKNOWN_METRIC, TASK_TOO_LARGE, RESPONSE_TOO_LARGE",
  403: "Запрос с недопустимого источника: FORBIDDEN_ORIGIN",
  404: "Объект или маршрут не найден: TASK_NOT_FOUND, COMMENT_NOT_FOUND, LOG_NOT_FOUND, NOT_FOUND",
  409: "Конфликт: REVISION_CONFLICT, VERSION_CONFLICT, BOARD_CHANGED, TASK_BLOCKED, TASK_ASSIGNED, TASK_NOT_READY, ASSIGNEE_MISMATCH, DEPENDENCY_CYCLE, PARENT_CYCLE, STORAGE_BUSY",
  413: "Тело JSON превышает 1 МиБ: PAYLOAD_TOO_LARGE",
  415: "Ожидается Content-Type: application/json: UNSUPPORTED_MEDIA_TYPE",
  500: "Ошибка хранилища или конфигурации: INVALID_DATA, INVALID_CONFIG, IO_ERROR",
};
