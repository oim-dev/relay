/** Совместимый путь к переносимому контракту расширяемого графа. */
export * from "@relay/contracts/entities/graph";
export * from "../storage/legacy/graph-event.js";
import { entityRefSchema } from "@relay/contracts/entities/graph";
import type { EntityRef } from "@relay/contracts/entities/graph";
import { parse } from "./validation.js";

/** Разбирает постоянный адрес; ключи разрешает общий резолвер в контексте проекта. */
export function parseEntityAddress(value: string): EntityRef {
  const [kind, id, extra] = value.split(":");
  return parse(
    entityRefSchema,
    { kind, id: extra === undefined ? id : undefined },
    "адрес сущности kind:id",
  );
}
