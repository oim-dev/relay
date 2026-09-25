import { createHash } from "node:crypto";
import { progressQuerySchema, progressPageQuerySchema } from "@relay/contracts/progress";
import type {
  ProgressAddress,
  ProgressKind,
  ProgressReason,
  ProgressQuery,
  ProgressPageQuery,
} from "@relay/contracts/progress";
import type { Workspace } from "../../storage/workspace.js";
import { ProductRepository } from "../../storage/product.js";
import { BoardTaskRepository } from "../../storage/board-tasks.js";
import { BoardRepository } from "../../storage/boards.js";
import { productAddresses } from "../../domain/product-addresses.js";
import { parse } from "../../domain/validation.js";
import { invariant } from "../../shared/errors.js";
import { resolveAddress } from "../entities/resolver.js";
import { taskCompletions } from "../board-tasks/completion.js";
import { productTaskStatuses, productTaskTargets } from "../product/task-progress.js";
import { validateProduct } from "../product/model.js";
import { planningRecords } from "../../storage/planning.js";

/** Согласованное предметное чтение и небольшие общие операции, без универсальных формул. */
export async function readProgressSnapshot(
  workspace: Workspace,
  kind: ProgressKind,
  input: ProgressQuery | ProgressPageQuery,
) {
  const query: {
    offset: number;
    limit: number;
    version?: string | undefined;
    ref?: string | undefined;
  } =
    kind === "product"
      ? parse(progressPageQuerySchema, input, "страница прогресса продукта")
      : parse(progressQuerySchema, input, "прогресс сущности");
  const repository = new ProductRepository(workspace);
  const records = (await repository.all()).sort((a, b) => a.id.localeCompare(b.id));
  const tasks = (await new BoardTaskRepository(workspace).all()).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const boards = (await new BoardRepository(workspace).all()).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  validateProduct(records);
  const completion = taskCompletions(tasks);
  const implementations = records.flatMap((record) => {
    const fields = record.fields;
    return fields.kind === "scope"
      ? fields.contracts.map((entry) => ({ ...entry, applicationId: fields.applicationId }))
      : [];
  });
  const scenarios = records.flatMap((record) =>
    record.fields.kind === "scenario"
      ? [{ id: record.id, featureId: record.fields.featureId }]
      : [],
  );
  const passport = records.find((entry) => entry.fields.kind === "passport");
  const addresses: ProgressAddress[] = [
    {
      kind: "product",
      id: repository.productId,
      key: passport?.key ?? null,
      title: passport?.fields.kind === "passport" ? passport.fields.name : "Продукт",
    },
    ...productAddresses(records).flatMap((entry): ProgressAddress[] =>
      ["feature", "scenario", "application", "implementation"].includes(entry.kind)
        ? [
            {
              kind: entry.kind as ProgressKind,
              id: entry.id,
              key: entry.key ?? null,
              title: entry.name,
            },
          ]
        : [],
    ),
    ...tasks.map((task): ProgressAddress => ({
      kind: "task",
      id: task.id,
      key: task.key,
      title: task.title,
    })),
  ];
  const address = (type: ProgressKind, id: string): ProgressAddress => {
    const value = addresses.find((entry) => entry.kind === type && entry.id === id);
    invariant(value, "INVALID_REFERENCE", `Не найдена составляющая ${type}:${id}`, 4);
    return value;
  };
  for (const task of tasks) for (const link of task.productLinks) address(link.kind, link.id);
  const implementationAliases = new Map<string, string[]>();
  if (kind === "implementation")
    for (const implementation of implementations) {
      const stored = await repository.implementation(
        implementation.applicationId,
        implementation.id,
        implementation.scenarioId !== null,
      );
      implementationAliases.set(stored.id, stored.reservedKeys ?? []);
    }
  const selected =
    kind === "product"
      ? addresses[0]!
      : resolveAddress(
          addresses.map((entry) => ({
            ref: { kind: entry.kind, id: entry.id },
            key: entry.key ?? entry.id,
            aliases:
              tasks.find((task) => entry.kind === "task" && task.id === entry.id)?.keys ??
              implementationAliases.get(entry.id) ??
              records.find((record) => record.id === entry.id)?.reservedKeys ??
              [],
            entity: entry,
          })),
          query.ref!,
          kind,
        ).entity;
  const version = createHash("sha256")
    .update(
      JSON.stringify([
        workspace.config.projectId,
        kind,
        selected.id,
        query.limit,
        records,
        tasks,
        boards,
        ...(kind === "task" ? [await planningRecords(workspace, "work-plan")] : []),
      ]),
    )
    .digest("hex");
  invariant(
    query.offset === 0 || query.version !== undefined,
    "INVALID_ARGUMENT",
    "Для продолжения укажите версию первой страницы",
    2,
  );
  invariant(
    query.version === undefined || query.version === version,
    "PROGRESS_CHANGED",
    "Прогресс изменился. Начните чтение с первой страницы",
    4,
  );
  const page = <T>(items: T[]) => ({
    items: items.slice(query.offset, query.offset + query.limit),
    total: items.length,
    nextOffset: query.offset + query.limit < items.length ? query.offset + query.limit : null,
  });
  const taskItem = (id: string) => ({
    ...address("task", id),
    column: tasks.find((task) => task.id === id)!.column,
    completed: completion.get(id)!.completed,
  });
  const counts = (ids: Set<string>) => ({
    total: ids.size,
    completed: [...ids].filter((id) => completion.get(id)!.completed).length,
  });
  const statuses = productTaskStatuses(tasks, implementations, scenarios);
  const item = (type: "feature" | "scenario" | "implementation", id: string) => ({
    ...address(type, id),
    completed: statuses.get(`${type}:${id}`) === "done",
  });
  const targetTasks = (type: "feature" | "scenario" | "implementation", id: string) => {
    const targets = productTaskTargets({ kind: type, id }, implementations, scenarios);
    return new Set(
      tasks
        .filter((task) => task.productLinks.some((link) => targets.has(`${link.kind}:${link.id}`)))
        .map((task) => task.id),
    );
  };
  const directTasks = tasks.filter((task) =>
    task.productLinks.some((link) => link.kind === kind && link.id === selected.id),
  );
  const reasons: ProgressReason[] = [];
  const reason = (code: ProgressReason["code"], message: string, source = selected) =>
    reasons.push({ code, message, source: address(source.kind, source.id) });
  const aggregate = (
    ids: Set<string>,
    components: (ProgressAddress & { completed: boolean })[],
  ) => {
    for (const component of components)
      if (!component.completed)
        reason("COMPONENT_INCOMPLETE", `Не выполнена составляющая: ${component.title}`, component);
    for (const task of directTasks)
      if (!completion.get(task.id)!.completed)
        reason(
          "COMPONENT_INCOMPLETE",
          `Не выполнена задача: ${task.key}`,
          address("task", task.id),
        );
    if (ids.size === 0)
      reason("NO_WORK", "В заявленном составе нет задач; отсутствие работ не является выполнением");
    return { entity: selected, version, counts: counts(ids), reasons: page(reasons) };
  };
  return {
    records,
    tasks,
    boards,
    implementations,
    active: implementations.filter((entry) => entry.active),
    scenarios,
    addresses,
    selected,
    version,
    completion,
    statuses,
    directTasks,
    reasons,
    reason,
    page,
    address,
    item,
    taskItem,
    counts,
    targetTasks,
    aggregate,
  };
}

/** Внутренние данные одного согласованного чтения, живущие только до ответа. */
export type ProgressSnapshot = Awaited<ReturnType<typeof readProgressSnapshot>>;
