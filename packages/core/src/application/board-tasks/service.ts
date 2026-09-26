import { createHash } from "node:crypto";
import {
  boardTaskRecordSchema,
  boardTaskReferenceSchema,
  boardTasksQuerySchema,
  createBoardTaskSchema,
  updateBoardTaskSchema,
  moveBoardTaskSchema,
  linkBoardTaskSchema,
  criteriaQuerySchema,
  criterionIdSchema,
  changeCriterionSchema,
  publishTaskCommentSchema,
  taskCommentsQuerySchema,
  taskCommentsPageSchema,
  taskCommentSchema,
} from "../../domain/board-task.js";
import type {
  BoardTaskRecord,
  BoardTaskView,
  BoardTaskSaved,
  BoardTasksQuery,
  CreateBoardTask,
  UpdateBoardTask,
  MoveBoardTask,
  LinkBoardTask,
  CriteriaQuery,
  ChangeCriterion,
  AcceptanceCriterion,
  PublishTaskComment,
  TaskCommentsQuery,
  TaskCommentsPage,
  TaskComment,
  TaskCommentSaved,
} from "../../domain/board-task.js";
import { defaultBoardPrefix } from "../../domain/board.js";
import type { Board } from "../../domain/board.js";
import { actorSchema, parse } from "../../domain/validation.js";
import { BoardTaskRepository } from "../../storage/board-tasks.js";
import { BoardRepository } from "../../storage/boards.js";
import type { Workspace } from "../../storage/workspace.js";
import { invariant, AppError } from "../../shared/errors.js";
import { shortId } from "../../shared/ids.js";
import { ProductRepository } from "../../storage/product.js";
import { entityKeySchema } from "@relay/contracts/primitives";
import { readEntityCatalog, resolveEntity, assertEntityKeyAvailable } from "../entities/catalog.js";
import { TaskActivityRepository, activityHash } from "../../storage/task-activity.js";
import type { ActivityFile } from "../../storage/task-activity.js";
import { decodeCommandResult } from "../../storage/unified-adapter.js";
import { productTaskTargets } from "../product/task-progress.js";
import { syncTaskRelations } from "../entities/owned-relations.js";
import { resolveAddress } from "../entities/resolver.js";
import { taskCompletions } from "./completion.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const versionOf = (tasks: BoardTaskRecord[]) => hash(tasks.map((task) => [task.id, task.revision]));
const ordered = (a: BoardTaskRecord, b: BoardTaskRecord) =>
  a.rank - b.rank || a.id.localeCompare(b.id);

/** Проверяет целостность и ацикличность зависимостей и декомпозиции независимо. */
function validate(tasks: BoardTaskRecord[], allowKeyCollisions = false) {
  const ids = new Set(tasks.map((task) => task.id));
  const keys = new Set<string>();
  for (const task of tasks) {
    invariant(
      new Set(task.acceptanceCriteria.map((criterion) => criterion.id)).size ===
        task.acceptanceCriteria.length,
      "INVALID_DATA",
      "Повтор ID критерия приёмки",
      5,
    );
    for (const criterion of task.acceptanceCriteria)
      invariant(
        criterion.completed
          ? criterion.completedAt !== null && criterion.completedBy !== null
          : criterion.completedAt === null && criterion.completedBy === null,
        "INVALID_DATA",
        "Отметка критерия не согласована с автором и временем",
        5,
      );
    invariant(
      task.keys.includes(task.key),
      "INVALID_DATA",
      "Текущий ключ отсутствует в истории",
      5,
    );
    for (const key of task.keys) {
      invariant(allowKeyCollisions || !keys.has(key), "INVALID_DATA", "Ключ задачи повторяется", 5);
      keys.add(key);
    }
    for (const id of [
      ...task.dependencies,
      ...task.related,
      ...(task.parentId ? [task.parentId] : []),
    ])
      invariant(
        id !== task.id && ids.has(id),
        "INVALID_REFERENCE",
        "Связь ведёт на себя или неизвестную задачу",
        4,
      );
    invariant(
      new Set(task.dependencies).size === task.dependencies.length &&
        new Set(task.related).size === task.related.length,
      "INVALID_DATA",
      "Повтор связи",
      5,
    );
  }
  for (const relation of ["dependencies", "parent"] as const) {
    const degrees = new Map<string, number>();
    const reverse = new Map<string, string[]>();
    for (const task of tasks) {
      const edges =
        relation === "dependencies" ? task.dependencies : task.parentId ? [task.parentId] : [];
      degrees.set(task.id, edges.length);
      for (const id of edges) reverse.set(id, [...(reverse.get(id) ?? []), task.id]);
    }
    const queue = [...degrees].filter(([, count]) => count === 0).map(([id]) => id);
    for (let index = 0; index < queue.length; index++) {
      for (const id of reverse.get(queue[index]!) ?? []) {
        const count = degrees.get(id)! - 1;
        degrees.set(id, count);
        if (count === 0) queue.push(id);
      }
    }
    invariant(
      queue.length === tasks.length,
      "DEPENDENCY_CYCLE",
      relation === "dependencies" ? "Зависимость создаёт цикл" : "Родительство создаёт цикл",
      4,
    );
  }
}

/** Строит порядок завершения: родитель ожидает детей и явно заданные зависимости. */
function completionGraph(tasks: BoardTaskRecord[]): Map<string, Set<string>> {
  const graph = new Map(tasks.map((task) => [task.id, new Set(task.dependencies)]));
  for (const task of tasks) {
    if (task.parentId !== null) graph.get(task.parentId)?.add(task.id);
  }
  return graph;
}

/** Запрещает новые смешанные циклы, сохраняя возможность читать и исправлять старые связи. */
function validateCompletionChanges(previous: BoardTaskRecord[], current: BoardTaskRecord[]): void {
  const before = completionGraph(previous);
  const after = completionGraph(current);
  for (const [source, targets] of after) {
    for (const target of targets) {
      if (before.get(source)?.has(target)) continue;
      const pending = [target];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const id = pending.pop()!;
        invariant(
          id !== source,
          "DEPENDENCY_CYCLE",
          "Подзадачи и зависимости создают цикл завершения",
          4,
        );
        if (visited.has(id)) continue;
        visited.add(id);
        pending.push(...(after.get(id) ?? []));
      }
    }
  }
}

function resolveTask(tasks: BoardTaskRecord[], reference: string): BoardTaskRecord {
  parse(boardTaskReferenceSchema, reference, "ссылка на задачу");
  try {
    const resolved = resolveAddress(
      tasks.map((task) => ({
        ref: { kind: "task", id: task.id },
        key: task.key,
        aliases: task.keys,
      })),
      reference,
      "task",
    );
    return tasks.find((task) => task.id === resolved.ref.id)!;
  } catch (error) {
    if (error instanceof AppError && error.code === "ENTITY_NOT_FOUND")
      throw new AppError("NOT_FOUND", "Задача не найдена в выбранном проекте", 3);
    throw error;
  }
}
function resolveBoard(boards: Board[], reference: string): Board {
  const value = reference.startsWith("board:") ? reference.slice(6) : reference;
  const board =
    boards.find((entry) => entry.id === value) ??
    boards.find(
      (entry) =>
        entry.id === value ||
        entry.key === value ||
        entry.aliases?.includes(value) ||
        entry.slug === value ||
        `BOARD-${entry.prefix ?? defaultBoardPrefix(entry.slug)}` === value ||
        (entry.prefix ?? defaultBoardPrefix(entry.slug)) === value,
    );
  invariant(board, "NOT_FOUND", "Доска не найдена в выбранном проекте", 3);
  return board;
}
function view(task: BoardTaskRecord, tasks: BoardTaskRecord[], boards: Board[]): BoardTaskView {
  const {
    version: _version,
    keys: _keys,
    requests: _requests,
    events: _events,
    acceptanceCriteria,
    ...data
  } = task;
  const acceptance = {
    total: acceptanceCriteria.length,
    completed: acceptanceCriteria.filter((criterion) => criterion.completed).length,
  };
  const completion = taskCompletions(
    [...tasks.filter((entry) => entry.id !== task.id), task],
    "blocked",
  ).get(task.id)!;
  const { blockers } = completion;
  const board = resolveBoard(boards, task.boardId);
  return {
    ...data,
    acceptance,
    canComplete: completion.canComplete,
    boardSlug: board.slug,
    blockers,
    blocked: blockers.length > 0,
    ready: task.column === "ready" && blockers.length === 0,
  };
}
function summary(task: BoardTaskRecord, tasks: BoardTaskRecord[], boards: Board[]) {
  const { description: _description, ...result } = view(task, tasks, boards);
  return result;
}
function page<T>(
  items: T[],
  query: { offset: number; limit: number; version?: string | undefined },
  version: string,
) {
  invariant(
    query.version === undefined || query.version === version,
    "BOARD_CHANGED",
    "Задачи изменились. Начните чтение с первой страницы.",
    4,
  );
  const selected = items.slice(query.offset, query.offset + query.limit);
  return {
    items: selected,
    total: items.length,
    nextOffset:
      query.offset + selected.length < items.length ? query.offset + selected.length : null,
    version,
  };
}

/** Единые операции канбана для Web, CLI и MCP; ID и связи сохраняются при переносе. */
export class BoardTasksService {
  constructor(readonly workspace: Workspace) {}

  private async read<T>(operation: (tasks: BoardTaskRecord[], boards: Board[]) => T): Promise<T> {
    return this.workspace.locked(async () => {
      const tasks = await new BoardTaskRepository(this.workspace).all();
      validate(tasks, this.workspace.storageSession !== undefined);
      return operation(tasks, await new BoardRepository(this.workspace).all());
    });
  }
  async list(input: BoardTasksQuery = {}) {
    const query = parse(boardTasksQuerySchema, input, "список задач доски");
    return this.read(async (tasks, boards) => {
      let targetAddresses: Set<string> | undefined;
      let pageVersion = versionOf(tasks);
      if (query.productTarget) {
        try {
          const catalog = await this.workspace.locked((owned) =>
            readEntityCatalog(this.workspace, owned),
          );
          const target = resolveEntity(catalog, query.productTarget, [
            "feature",
            "scenario",
            "implementation",
          ]).ref;
          const implementations = catalog.entries.flatMap((entry) =>
            entry.data.kind === "implementation" ? [{ id: entry.ref.id, ...entry.data }] : [],
          );
          const scenarios = catalog.entries.flatMap((entry) =>
            entry.data.kind === "scenario"
              ? [{ id: entry.ref.id, featureId: entry.data.featureId }]
              : [],
          );
          targetAddresses = productTaskTargets(target, implementations, scenarios);
          pageVersion = hash([pageVersion, [...targetAddresses].sort()]);
        } catch (error) {
          // Совместимый список канбана возвращает пустую выборку для отсутствующей цели.
          if (!(error instanceof AppError) || error.code !== "ENTITY_NOT_FOUND") throw error;
        }
      }
      const board = query.board === undefined ? undefined : resolveBoard(boards, query.board);
      const parent = query.parentId === undefined ? undefined : resolveTask(tasks, query.parentId);
      const selected = tasks
        .filter((task) => {
          const state = view(task, tasks, boards);
          return (
            (!board || task.boardId === board.id) &&
            (!parent || task.parentId === parent.id) &&
            (!query.column || task.column === query.column) &&
            (!query.completion ||
              (query.completion === "finished") ===
                (task.column === "done" || task.column === "cancelled")) &&
            (!query.productTarget ||
              task.productLinks.some((link) => targetAddresses?.has(`${link.kind}:${link.id}`))) &&
            (!query.q ||
              `${task.id} ${task.keys.join(" ")} ${task.title} ${query.searchIn === "title" ? "" : task.description}`
                .toLocaleLowerCase()
                .includes(query.q.toLocaleLowerCase())) &&
            (!query.readiness || (query.readiness === "blocked" ? state.blocked : state.ready))
          );
        })
        .sort(ordered)
        .map((task) => summary(task, tasks, boards));
      return page(selected, query, pageVersion);
    });
  }
  async get(reference: string) {
    return this.read((tasks, boards) => view(resolveTask(tasks, reference), tasks, boards));
  }

  /** Ограниченная лента, без чтения полного Markdown всех событий. */
  /** Обсуждение не предоставляет доступа к автоматическим событиям прежней ленты. */
  async listComments(reference: string, input: TaskCommentsQuery = {}): Promise<TaskCommentsPage> {
    const query = parse(taskCommentsQuerySchema, input, "список комментариев");
    return this.read(async (tasks) => {
      const page = await new TaskActivityRepository(this.workspace).list(
        resolveTask(tasks, reference),
        query,
        true,
      );
      return parse(taskCommentsPageSchema, page, "страница комментариев");
    });
  }

  async getComment(reference: string, id: string): Promise<TaskComment> {
    return this.read(async (tasks) => {
      const event = await new TaskActivityRepository(this.workspace).event(
        resolveTask(tasks, reference),
        id,
      );
      invariant(event.action === "comment-publish", "NOT_FOUND", "Сообщение не найдено", 3);
      return parse(taskCommentSchema, event, "комментарий");
    });
  }


  /** Публикация независима от ревизии описания; квитанция и событие сохраняются вместе. */
  async publishComment(reference: string, input: PublishTaskComment) {
    const command = parse(publishTaskCommentSchema, input, "сообщение обсуждения");
    return this.workspace.mutate(
      "task-comment",
      { ...command, reference },
      command.actor,
      async (owned) => {
        const session = this.workspace.storageSession;
        invariant(session, "STORAGE_MIGRATION_REQUIRED", "Для записи выполните storage migrate", 4);
        const key = activityHash([command.actor, command.requestId]);
        const receipt = await session.taskReceipt(key);
        invariant(
          receipt?.kind !== "task",
          "IDEMPOTENCY_CONFLICT",
          "Ключ запроса уже использован для изменения задачи",
          4,
        );
        if (receipt) {
          const target = await session.resolveReceiptTarget(reference, "task");
          invariant(
            receipt.hash === activityHash(["comment-publish", target.id, command]),
            "IDEMPOTENCY_CONFLICT",
            "Ключ запроса использован с другим содержимым",
            4,
          );
          return decodeCommandResult<TaskCommentSaved>("task-comment", receipt.result);
        }
        const repository = new BoardTaskRepository(this.workspace);
        const tasks = await repository.all();
        const task = resolveTask(tasks, reference);
        const activity = new TaskActivityRepository(this.workspace);
        const requestHash = activityHash(["comment-publish", task.id, command]);
        const boards = await new BoardRepository(this.workspace).all();
        const at = new Date().toISOString();
        const sequence = (await activity.sequence(task)) + 1;
        const result = {
          id: task.id,
          commentId: String(sequence),
          revision: sequence,
          action: "comment-publish" as const,
          requestId: command.requestId,
        };
        const files = await activity.prepare(task, [
          {
            at,
            actor: command.actor,
            actorRole: command.actorRole,
            action: "comment-publish",
            title: command.title,
            description: command.description,
            operationId: key,
            revision: task.revision,
            legacy: false,
            fields: [],
            changes: [],
          },
        ]);
        files.push(
          { path: `receipts/${key}.json`, value: { hash: requestHash, result } },
          { path: "signal.json", value: { operationId: key, at } },
        );
        const board = resolveBoard(boards, task.boardId);
        await repository.save(
          task.version === 5 ? [] : [{ slug: board.slug, task: { ...task, version: 5 } }],
          [],
          owned,
          files,
        );
        return result;
      },
    );
  }

  /** Читает ограниченную страницу критериев без полного Markdown. */
  async listCriteria(reference: string, input: CriteriaQuery = {}) {
    const query = parse(criteriaQuerySchema, input, "список критериев приёмки");
    return this.read((tasks) => {
      const task = resolveTask(tasks, reference);
      const items = task.acceptanceCriteria.map(
        ({ description: _description, ...criterion }) => criterion,
      );
      return { ...page(items, query, String(task.revision)), revision: task.revision };
    });
  }

  /** Читает полное описание одного критерия с ревизией задачи. */
  async getCriterion(reference: string, criterionId: string) {
    parse(criterionIdSchema, criterionId, "ID критерия");
    return this.read((tasks) => {
      const task = resolveTask(tasks, reference);
      const criterion = task.acceptanceCriteria.find((entry) => entry.id === criterionId);
      invariant(criterion, "NOT_FOUND", "Критерий приёмки не найден", 3);
      return { criterion, revision: task.revision };
    });
  }

  /** Изменяет один критерий под блокировкой, с ревизией и квитанцией повтора. */
  async changeCriterion(reference: string, input: ChangeCriterion, actor: string) {
    const command = parse(changeCriterionSchema, input, "изменение критерия приёмки");
    return this.mutate(
      `criterion-${command.action}`,
      reference,
      command,
      actor,
      (_tasks, _boards, previous, author) => {
        invariant(previous, "NOT_FOUND", "Задача не найдена", 3);
        invariant(
          previous.column !== "done",
          "TASK_ACCEPTANCE_LOCKED",
          "Сначала верните задачу из готовых, чтобы изменить критерии приёмки",
          4,
        );
        const criteria = structuredClone(previous.acceptanceCriteria);
        const now = new Date().toISOString();
        if (command.action === "add") {
          invariant(
            criteria.length < 100,
            "VALIDATION_ERROR",
            "В задаче допускается не более 100 критериев",
            2,
          );
          const usedIds = [
            ...criteria.map((entry) => entry.id),
            ...Object.values(previous.requests).flatMap((receipt) =>
              receipt.result.criterionId ? [receipt.result.criterionId] : [],
            ),
          ];
          criteria.push({
            id: shortId(usedIds),
            title: command.title,
            summary: command.summary,
            description: command.description,
            completed: false,
            completedAt: null,
            completedBy: null,
          });
        } else {
          const criterion = criteria.find((entry) => entry.id === command.criterionId);
          invariant(criterion, "NOT_FOUND", "Критерий приёмки не найден", 3);
          if (command.action === "remove") criteria.splice(criteria.indexOf(criterion), 1);
          if (command.action === "complete" && criterion.completed !== command.completed) {
            criterion.completed = command.completed;
            criterion.completedAt = command.completed ? now : null;
            criterion.completedBy = command.completed ? author : null;
          }
          if (command.action === "update") {
            invariant(
              command.title !== undefined ||
                command.summary !== undefined ||
                command.description !== undefined,
              "VALIDATION_ERROR",
              "Изменения критерия не заданы",
              2,
            );
            const changed = (["title", "summary", "description"] as const).some(
              (field) => command[field] !== undefined && command[field] !== criterion[field],
            );
            for (const field of ["title", "summary", "description"] as const) {
              const value = command[field];
              if (value !== undefined) criterion[field] = value;
            }
            if (changed)
              Object.assign(criterion, { completed: false, completedAt: null, completedBy: null });
          }
        }
        return {
          ...previous,
          acceptanceCriteria: criteria,
          revision: previous.revision + 1,
          updatedAt: now,
          updatedBy: author,
        };
      },
    );
  }

  async links(reference: string, input: BoardTasksQuery = {}) {
    const query = parse(boardTasksQuerySchema, input, "список связей задачи");
    return this.read((tasks, boards) => {
      const task = resolveTask(tasks, reference);
      const items: {
        relation: "depends-on" | "blocks" | "related" | "parent" | "child";
        task: ReturnType<typeof summary>;
      }[] = [];
      for (const other of tasks) {
        const add = (relation: (typeof items)[number]["relation"]) =>
          items.push({ relation, task: summary(other, tasks, boards) });
        if (task.dependencies.includes(other.id)) add("depends-on");
        if (other.dependencies.includes(task.id)) add("blocks");
        if (task.related.includes(other.id) || other.related.includes(task.id)) add("related");
        if (task.parentId === other.id) add("parent");
        if (other.parentId === task.id) add("child");
      }
      return page(items, query, versionOf(tasks));
    });
  }

  private async mutate(
    action: BoardTaskSaved["action"],
    reference: string | undefined,
    input: {
      requestId: string;
      actor?: string | undefined;
      ifRevision?: number | undefined;
      ifVersion?: string | undefined;
    },
    defaultActor: string,
    change: (
      tasks: BoardTaskRecord[],
      boards: Board[],
      previous: BoardTaskRecord | undefined,
      actor: string,
    ) => BoardTaskRecord | Promise<BoardTaskRecord>,
  ): Promise<BoardTaskSaved> {
    const actor = parse(actorSchema, input.actor ?? defaultActor, "автор");
    return this.workspace.mutate(
      "board-task",
      { ...input, action, reference: reference ?? null },
      actor,
      async (assertOwned) => {
        const session = this.workspace.storageSession;
        invariant(session, "STORAGE_MIGRATION_REQUIRED", "Для записи выполните storage migrate", 4);
        const requestKey = hash([actor, input.requestId]);
        const receipt = await session.taskReceipt(requestKey);
        invariant(
          receipt?.kind !== "comment",
          "IDEMPOTENCY_CONFLICT",
          "Ключ запроса уже использован для обсуждения",
          4,
        );
        const normalizedInput: Record<string, unknown> = { ...input, actor };
        if (normalizedInput.includeTask === false) delete normalizedInput.includeTask;
        if (receipt) {
          const targetId = reference ? (await session.resolveReceiptTarget(reference, "task")).id : undefined;
          invariant(
            receipt.hash === hash([action, targetId, normalizedInput]),
            "IDEMPOTENCY_CONFLICT",
            "Ключ запроса использован с другим содержимым",
            4,
          );
          return decodeCommandResult<BoardTaskSaved>("board-task", receipt.result);
        }
        const repository = new BoardTaskRepository(this.workspace);
        const tasks = await repository.all();
        validate(tasks, true);
        const boards = await new BoardRepository(this.workspace).all();
        const previous = reference ? resolveTask(tasks, reference) : undefined;
        const requestHash = hash([action, previous?.id, normalizedInput]);
        invariant(
          !previous || previous.revision === input.ifRevision,
          "REVISION_CONFLICT",
          "Задача изменилась. Прочитайте её заново; введённые данные можно сохранить после сверки.",
          4,
          { actual: previous?.revision },
        );
        invariant(
          input.ifVersion === undefined || input.ifVersion === versionOf(tasks),
          "BOARD_CHANGED",
          "Порядок задач изменился. Повторите перенос после обновления доски.",
          4,
        );
        const before = new Map(tasks.map((task) => [task.id, JSON.stringify(task)]));
        const originalTasks = structuredClone(tasks);
        const next = await change(tasks, boards, previous, actor);
        invariant(
          action !== "create" ||
            next.column !== "done" ||
            next.acceptanceCriteria.every((criterion) => criterion.completed),
          "TASK_ACCEPTANCE_INCOMPLETE",
          "Нельзя создать готовую задачу с невыполненными критериями приёмки",
          4,
        );
        invariant(
          action !== "create" || next.column !== "done" || !view(next, tasks, boards).blocked,
          "TASK_BLOCKED",
          "Нельзя создать готовую задачу с невыполненными зависимостями",
          4,
        );
        if (!previous || previous.key !== next.key)
          assertEntityKeyAvailable(await readEntityCatalog(this.workspace, assertOwned), next.key, {
            kind: "task",
            id: next.id,
          });
        next.version = 5;
        next.events = previous?.events ?? [];
        const result: BoardTaskSaved = {
          id: next.id,
          key: next.key,
          boardId: next.boardId,
          revision: next.revision,
          action,
          requestId: input.requestId,
        };
        if (action.startsWith("criterion-")) {
          result.criterionId =
            "criterionId" in input && typeof input.criterionId === "string"
              ? input.criterionId
              : next.acceptanceCriteria.at(-1)?.id;
        }
        if (action === "create" && "includeTask" in input && input.includeTask === true)
          result.task = view(next, [...tasks, next], boards);
        next.requests[requestKey] = { hash: requestHash, result };
        for (const task of tasks) {
          if (task.id !== next.id && before.get(task.id) !== JSON.stringify(task)) {
            task.version = 5;
          }
        }
        const candidates = [...tasks.filter((task) => task.id !== next.id), next].map((task) =>
          parse(boardTaskRecordSchema, task, "задача"),
        );
        validate(candidates, this.workspace.storageSession !== undefined);
        validateCompletionChanges(tasks, candidates);
        const activity: ActivityFile[] = [];
        if (!this.workspace.storageSession) for (const candidate of candidates) {
          if (before.get(candidate.id) === JSON.stringify(candidate)) continue;
          const old = originalTasks.find((entry) => entry.id === candidate.id);
          activity.push(...await new TaskActivityRepository(this.workspace).prepare(old ?? { ...candidate, version: 4, events: [] }, []));
        }
        const writes = candidates
          .filter((task) => before.get(task.id) !== JSON.stringify(task))
          .map((task) => ({ slug: resolveBoard(boards, task.boardId).slug, task }));
        const removes =
          previous && previous.boardId !== next.boardId
            ? [{ slug: resolveBoard(boards, previous.boardId).slug, id: previous.id }]
            : [];
        await repository.save(writes, removes, assertOwned, activity);
        await syncTaskRelations(
          this.workspace,
          writes.map((entry) => entry.task),
        );
        return result;
      },
    );
  }

  private async nextKey(tasks: BoardTaskRecord[], board: Board) {
    if (this.workspace.storageSession) return this.workspace.storageSession.nextKey(board.id);
    const prefix = board.prefix ?? defaultBoardPrefix(board.slug);
    const catalog = await this.workspace.locked((owned) =>
      readEntityCatalog(this.workspace, owned),
    );
    const numbers = [
      ...catalog.reservedKeys,
      ...tasks.flatMap((task) => task.keys),
      ...catalog.entries.flatMap((entry) => [entry.key, ...entry.aliases]),
    ]
      .filter((key) => new RegExp(`^${prefix}-[1-9]\\d*$`).test(key))
      .map((key) => Number(key.slice(prefix.length + 1)));
    const number = numbers.reduce((max, value) => Math.max(max, value), 0) + 1;
    invariant(Number.isSafeInteger(number), "INVALID_DATA", "Номера задач исчерпаны", 5);
    return `${prefix}-${number}`;
  }
  /** Новые цели проверяются под той же блокировкой; снятые контракты можно оставить в старых связях. */
  private async validateProductLinks(
    links: BoardTaskRecord["productLinks"],
    board: Board,
    previous: BoardTaskRecord["productLinks"] = [],
  ) {
    if (links.length === 0) return [];
    invariant(
      board.kind !== "infrastructure",
      "INVALID_REFERENCE",
      "На инфраструктурной доске нет целей реализации. Сначала снимите продуктовые связи",
      4,
    );
    const records = await new ProductRepository(this.workspace).all();
    const catalog = await this.workspace.locked((owned) =>
      readEntityCatalog(this.workspace, owned),
    );
    const normalized = links.map((link) => {
      try {
        return { ...link, id: resolveEntity(catalog, link.id, link.kind).ref.id };
      } catch (error) {
        if (
          error instanceof AppError &&
          ["ENTITY_NOT_FOUND", "ENTITY_KIND_MISMATCH"].includes(error.code)
        )
          throw new AppError("INVALID_REFERENCE", error.message, 4);
        throw error;
      }
    });
    const seen = new Set<string>();
    for (const link of normalized) {
      const key = `${link.kind}:${link.id}`;
      invariant(!seen.has(key), "INVALID_ARGUMENT", "Продуктовая связь повторяется", 4);
      seen.add(key);
      invariant(
        board.kind === "product" ? link.kind !== "implementation" : link.kind === "implementation",
        "INVALID_REFERENCE",
        board.kind === "product"
          ? "На продуктовой доске доступны только фичи и сценарии продукта. Сначала снимите несовместимые связи"
          : "На доске приложения доступны только его реализации. Сначала снимите несовместимые связи",
        4,
      );
      const isExisting = previous.some((item) => item.id === link.id && item.kind === link.kind);
      const exists =
        link.kind === "implementation"
          ? records.some(
              (record) =>
                record.fields.kind === "scope" &&
                record.fields.applicationId === board.applicationId &&
                record.fields.contracts.some(
                  (contract) => contract.id === link.id && (contract.active || isExisting),
                ),
            )
          : records.some((record) => record.id === link.id && record.fields.kind === link.kind);
      invariant(
        exists,
        "INVALID_REFERENCE",
        "Цель отсутствует, её участие снято или она принадлежит другому приложению. Снимите несовместимые связи",
        4,
      );
    }
    return normalized;
  }
  async create(input: CreateBoardTask, actor: string) {
    const command = parse(createBoardTaskSchema, input, "создание задачи");
    return this.mutate(
      "create",
      undefined,
      command,
      actor,
      async (tasks, boards, _previous, author) => {
        const board = resolveBoard(boards, command.board);
        const productLinks = await this.validateProductLinks(command.productLinks ?? [], board);
        const parent =
          command.parentId === undefined ? undefined : resolveTask(tasks, command.parentId);
        invariant(
          parent?.column !== "done" || command.column === "done",
          "TASK_BLOCKED",
          "Сначала верните родительскую задачу из готовых: подзадача ещё не выполнена",
          4,
        );
        const key = await this.nextKey(tasks, board);
        const now = new Date().toISOString();
        const acceptanceCriteria: AcceptanceCriterion[] = [];
        for (const content of command.acceptanceCriteria ?? [])
          acceptanceCriteria.push({
            ...content,
            id: shortId(acceptanceCriteria.map((entry) => entry.id)),
            completed: false,
            completedAt: null,
            completedBy: null,
          });
        const rank =
          tasks
            .filter((task) => task.boardId === board.id && task.column === command.column)
            .reduce((max, task) => Math.max(max, task.rank), 0) + 1024;
        return {
          version: 4,
          acceptanceCriteria,
          id: shortId(tasks.map((task) => task.id)),
          key,
          keys: [key],
          boardId: board.id,
          title: command.title,
          description: command.description,
          productLinks,
          column: command.column,
          rank,
          revision: 1,
          dependencies: (command.dependencies ?? []).map((ref) => resolveTask(tasks, ref).id),
          related: (command.related ?? []).map((ref) => resolveTask(tasks, ref).id),
          parentId: parent?.id ?? null,
          createdAt: now,
          updatedAt: now,
          createdBy: author,
          updatedBy: author,
          requests: {},
        };
      },
    );
  }
  async update(reference: string, input: UpdateBoardTask, actor: string) {
    const command = parse(updateBoardTaskSchema, input, "редактирование задачи");
    invariant(
      command.title !== undefined ||
        command.description !== undefined ||
        command.productLinks !== undefined,
      "INVALID_ARGUMENT",
      "Изменения не заданы",
    );
    return this.mutate(
      "update",
      reference,
      command,
      actor,
      async (_tasks, boards, previous, author) => {
        const productLinks =
          command.productLinks === undefined
            ? previous!.productLinks
            : await this.validateProductLinks(
                command.productLinks,
                resolveBoard(boards, previous!.boardId),
                previous!.productLinks,
              );
        return {
          ...previous!,
          title: command.title ?? previous!.title,
          description: command.description ?? previous!.description,
          productLinks,
          revision: previous!.revision + 1,
          updatedAt: new Date().toISOString(),
          updatedBy: author,
        };
      },
    );
  }
  async move(reference: string, input: MoveBoardTask, actor: string) {
    const command = parse(moveBoardTaskSchema, input, "перемещение задачи");
    return this.mutate(
      "move",
      reference,
      command,
      actor,
      async (tasks, boards, previous, author) => {
        const task = previous!;
        if (command.beforeId !== null) command.beforeId = resolveTask(tasks, command.beforeId).id;
        const board = resolveBoard(boards, command.board ?? task.boardId);
        if (board.id !== task.boardId)
          await this.validateProductLinks(task.productLinks, board, task.productLinks);
        invariant(
          command.column !== "done" ||
            task.acceptanceCriteria.every((criterion) => criterion.completed),
          "TASK_ACCEPTANCE_INCOMPLETE",
          "Нельзя завершить задачу: остались невыполненные критерии приёмки",
          4,
          {
            criterionIds: task.acceptanceCriteria
              .filter((criterion) => !criterion.completed)
              .map((criterion) => criterion.id),
          },
        );
        invariant(
          command.column !== "done" || !view(task, tasks, boards).blocked,
          "TASK_BLOCKED",
          "Нельзя завершить задачу: остались незавершённые подзадачи или зависимости",
          4,
        );
        const column = tasks
          .filter(
            (entry) =>
              entry.id !== task.id && entry.boardId === board.id && entry.column === command.column,
          )
          .sort(ordered);
        const index =
          command.beforeId === null
            ? column.length
            : column.findIndex((entry) => entry.id === command.beforeId);
        invariant(
          index >= 0,
          "INVALID_REFERENCE",
          "Место вставки отсутствует в целевой колонке",
          4,
        );
        const now = new Date().toISOString();
        // Перенумеровка целевой колонки публикуется общей транзакцией и не теряет параллельные переносы.
        column.splice(index, 0, task);
        for (let position = 0; position < column.length; position++) {
          const entry = column[position]!;
          const rank = (position + 1) * 1024;
          if (entry.id !== task.id && entry.rank !== rank) {
            entry.rank = rank;
            entry.revision++;
            entry.updatedAt = now;
            entry.updatedBy = author;
          }
        }
        const key = board.id === task.boardId ? task.key : await this.nextKey(tasks, board);
        return {
          ...task,
          key,
          keys: key === task.key ? [...task.keys] : [...task.keys, key],
          boardId: board.id,
          column: command.column,
          rank: (index + 1) * 1024,
          revision: task.revision + 1,
          updatedAt: now,
          updatedBy: author,
        };
      },
    );
  }
  /** Меняет только читаемый адрес; ID, доска и все прежние ключи сохраняются. */
  async rename(
    reference: string,
    input: { key: string; ifRevision: number; requestId: string; actor?: string },
    actor: string,
  ) {
    const key = parse(entityKeySchema, input.key, "новый ключ задачи");
    const command = { ...input, key };
    return this.mutate(
      "rename",
      reference,
      command,
      actor,
      (_tasks, _boards, previous, author) => ({
        ...previous!,
        key,
        keys: [...new Set([...previous!.keys, key])],
        revision: previous!.revision + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: author,
      }),
    );
  }
  async link(reference: string, input: LinkBoardTask, actor: string) {
    const command = parse(linkBoardTaskSchema, input, "связь задач");
    return this.mutate("link", reference, command, actor, (tasks, _boards, previous, author) => {
      const task = structuredClone(previous!);
      const target = resolveTask(tasks, command.target);
      invariant(target.id !== task.id, "INVALID_REFERENCE", "Нельзя связать задачу с собой", 4);
      const now = new Date().toISOString();
      if (command.relation === "parent") {
        if (command.remove) {
          invariant(
            task.parentId === target.id,
            "INVALID_REFERENCE",
            "Указанная родительская связь отсутствует",
            4,
          );
          task.parentId = null;
        } else {
          invariant(
            target.column !== "done" || taskCompletions(tasks).get(task.id)!.completed,
            "TASK_BLOCKED",
            "Сначала верните родительскую задачу из готовых: подзадача ещё не выполнена",
            4,
          );
          task.parentId = target.id;
        }
      } else {
        const field = command.relation === "depends-on" ? "dependencies" : "related";
        task[field] = task[field].filter((id) => id !== target.id);
        if (!command.remove) task[field].push(target.id);
        if (field === "related" && target.related.includes(task.id)) {
          target.related = target.related.filter((id) => id !== task.id);
          target.revision++;
          target.updatedAt = now;
          target.updatedBy = author;
        }
        invariant(
          task.column !== "done" ||
            field !== "dependencies" ||
            command.remove ||
            taskCompletions(tasks).get(target.id)!.completed,
          "TASK_BLOCKED",
          "Сначала верните задачу из готовых: зависимость ещё не выполнена",
          4,
        );
      }
      return { ...task, revision: task.revision + 1, updatedAt: now, updatedBy: author };
    });
  }
}
