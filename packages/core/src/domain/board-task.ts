/** Совместимый путь к общему контракту задач досок. */
export * from "@relay/contracts/entities/board-task";
export * from "../storage/legacy/task-activity.js";
export { boardTaskRecordSchema } from "./legacy-records.js";
export type { BoardTaskRecord } from "./legacy-records.js";
