import { createHash } from "node:crypto";
import {
  TASK_CONTEXT_CONTRACT_VERSION,
  TASK_CONTEXT_LIMITS,
  taskContextQuerySchema,
  taskContextSchema,
} from "@relay/contracts/task-context";
import type {
  TaskContext,
  TaskContextQuery,
  TaskContextReason,
  TaskContextRecord,
} from "@relay/contracts/task-context";
import type { EntityDetail, EntityRef } from "@relay/contracts/entities";
import { parse } from "../../domain/validation.js";
import { AppError, invariant } from "../../shared/errors.js";
import type { Workspace } from "../../storage/workspace.js";
import { EntityEngine } from "../entities/service.js";
import { BoardTasksService } from "./service.js";

type Section = "targets" | "requirements" | "applications" | "product" | "documents";
const address = (ref: EntityRef) => `${ref.kind}:${ref.id}`;

/**
 * Контекст исполнения задачи: задача, критерии, цели FI/SI с их требованиями и приложениями,
 * паспорт и прикреплённые документы — одним чтением под общей блокировкой.
 * Состав определяется предметными связями, а не обходом диагностического графа.
 */
export class TaskContextService {
  constructor(readonly workspace: Workspace) {}

  async read(reference: string, input: TaskContextQuery = {}): Promise<TaskContext> {
    const query = parse(taskContextQuerySchema, input, "контекст задачи");
    return this.workspace.locked(async () => {
      const entities = new EntityEngine(this.workspace);
      const execution = await new BoardTasksService(this.workspace).execution(reference);
      const included = new Map<
        string,
        { section: Section; record: EntityDetail; reasons: TaskContextReason[] }
      >();
      const reasonKey = (reason: TaskContextReason) =>
        `${reason.code}:${reason.from ? address(reason.from) : ""}`;
      const include = async (
        ref: EntityRef,
        section: Section,
        reason: TaskContextReason,
        known?: EntityDetail,
      ) => {
        const existing = included.get(address(ref));
        if (existing) {
          if (!existing.reasons.some((entry) => reasonKey(entry) === reasonKey(reason)))
            existing.reasons.push(reason);
          return existing.record;
        }
        invariant(
          included.size < TASK_CONTEXT_LIMITS.records,
          "CONTEXT_TOO_LARGE",
          "Контекст задачи превышает технический предел числа записей",
          4,
          { limit: TASK_CONTEXT_LIMITS.records },
        );
        const record = known ?? (await entities.get({ ref: ref.id, kind: ref.kind }));
        included.set(address(record.ref), { section, record, reasons: [reason] });
        return record;
      };
      const taskRef: EntityRef = { kind: "task", id: execution.task.id };

      // Цели и их владельцы: FI → фича, SI → сценарий и его фича, у реализаций — приложение.
      const targets: EntityDetail[] = [];
      for (const link of execution.task.productLinks)
        targets.push(
          await include({ kind: link.kind, id: link.id }, "targets", {
            code: "task-target",
            from: taskRef,
          }),
        );
      const owners: EntityDetail[] = [];
      for (const target of targets) {
        const data = target.data;
        if (data.kind === "implementation") {
          owners.push(
            await include({ kind: "feature", id: data.featureId }, "requirements", {
              code: "target-feature",
              from: target.ref,
            }),
          );
          if (data.scenarioId)
            owners.push(
              await include({ kind: "scenario", id: data.scenarioId }, "requirements", {
                code: "target-scenario",
                from: target.ref,
              }),
            );
          owners.push(
            await include({ kind: "application", id: data.applicationId }, "applications", {
              code: "target-application",
              from: target.ref,
            }),
          );
        }
        if (data.kind === "scenario")
          owners.push(
            await include({ kind: "feature", id: data.featureId }, "requirements", {
              code: "target-feature",
              from: target.ref,
            }),
          );
      }

      let passport: EntityDetail | undefined;
      try {
        passport = await entities.get({ ref: "passport", kind: "product" });
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "ENTITY_NOT_FOUND") throw error;
      }
      if (passport)
        await include(passport.ref, "product", { code: "product-passport", from: null }, passport);

      // Документы читаются тем же фильтром target, что и каталог сущностей.
      const attached = async (owner: EntityRef, reason: TaskContextReason["code"]) => {
        let offset: number | null = 0;
        let version: string | undefined;
        while (offset !== null) {
          // Типизированный адрес исключает совпадение ID с ключом другой сущности;
          // архивные документы не передаются как действующие материалы.
          const page = await entities.list({
            kind: "document",
            target: address(owner),
            archived: "false",
            limit: 100,
            offset,
            ...(version === undefined ? {} : { version }),
          });
          version = page.version;
          for (const item of page.items)
            await include(item.ref, "documents", {
              code: reason,
              from: owner,
            });
          offset = page.nextOffset;
        }
      };
      await attached(taskRef, "task-document");
      if (query.targetDocuments === "true") {
        const seen = new Set<string>();
        for (const owner of [...targets, ...owners])
          if (!seen.has(address(owner.ref))) {
            seen.add(address(owner.ref));
            await attached(owner.ref, "target-document");
          }
      }

      const grouped = (section: Section): TaskContextRecord[] =>
        [...included.values()]
          .filter((entry) => entry.section === section)
          .map(({ record, reasons }) => ({ record, reasons }));
      const body: Omit<TaskContext, "consistency"> = {
        contractVersion: TASK_CONTEXT_CONTRACT_VERSION,
        task: { ...execution.task, criteria: execution.criteria },
        targets: grouped("targets"),
        requirements: grouped("requirements"),
        applications: grouped("applications"),
        product: grouped("product")[0] ?? null,
        documents: grouped("documents"),
        dependencies: execution.dependencies,
        children: execution.children,
        complete: true,
        limits: { ...TASK_CONTEXT_LIMITS },
      };
      // Отпечаток всего содержания, включая вычисляемые блокеры, статусы и ключи ссылок.
      const encoded = JSON.stringify([query.targetDocuments ?? "false", body]);
      const result: TaskContext = {
        ...body,
        consistency: `task-context-v1:${createHash("sha256").update(encoded).digest("hex")}`,
      };
      invariant(
        Buffer.byteLength(JSON.stringify(result), "utf8") <= TASK_CONTEXT_LIMITS.bytes,
        "CONTEXT_TOO_LARGE",
        "Контекст задачи превышает бюджет ответа; данные не усечены",
        4,
        { limit: TASK_CONTEXT_LIMITS.bytes },
      );
      return parse(taskContextSchema, result, "контекст задачи", true);
    });
  }
}
