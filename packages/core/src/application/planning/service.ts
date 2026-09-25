import {
  createPlanSchema,
  updatePlanSchema,
  transitionPlanSchema,
  changeStageSchema,
  stageFieldsSchema,
  workPlanSchema,
  changePlanTasksSchema,
  transferPlanTaskSchema,
  plansQuerySchema,
  planningCandidatesQuerySchema,
} from "@relay/contracts/planning";
import type {
  CreatePlan,
  UpdatePlan,
  TransitionPlan,
  ChangeStage,
  ChangePlanTasks,
  TransferPlanTask,
  PlansQuery,
  PlanningPageQuery,
  WorkPlan,
  PlanStage,
  PlanningCandidatesQuery,
} from "@relay/contracts/planning";
import { actorSchema } from "@relay/contracts/primitives";
import type { Workspace } from "../../storage/workspace.js";
import {
  planningSession,
  planningRecord,
  planningRecords,
  createPlanning,
  savePlanning,
  assertEditable,
  assertRevision,
  planningPage,
  planningSaved,
} from "../../storage/planning.js";
import { shortId } from "../../shared/ids.js";
import { invariant } from "../../shared/errors.js";
import { BoardTasksService } from "../board-tasks/service.js";
import { readPlanningState } from "./model.js";
import { syncPlanRelations } from "./relations.js";

/** Владелец планов, этапов и участия существующих задач. */
export class PlanningService {
  constructor(readonly workspace: Workspace) {}

  private write<T>(
    input: { actor?: string | undefined; requestId: string },
    actor: string,
    action: string,
    reference: string | undefined,
    operation: (author: string) => Promise<T>,
  ) {
    const author = actorSchema.parse(input.actor ?? actor);
    return this.workspace.mutate(
      "planning",
      { ...input, action, ...(reference === undefined ? {} : { reference }) },
      author,
      async () => {
        planningSession(this.workspace);
        return operation(author);
      },
    );
  }
  private async fields(plan: Pick<WorkPlan, "scope" | "participants">) {
    invariant(
      new Set(plan.participants).size === plan.participants.length,
      "DUPLICATE_VALUE",
      "Участник плана повторяется",
      4,
    );
    invariant(
      new Set(plan.scope.map((ref) => `${ref.kind}:${ref.id}`)).size === plan.scope.length,
      "DUPLICATE_VALUE",
      "Область плана повторяется",
      4,
    );
    for (const ref of plan.scope) await planningSession(this.workspace).get(ref);
  }
  async list(input: PlansQuery = {}) {
    const query = plansQuerySchema.parse(input);
    return this.workspace.locked(async () => {
      const state = await readPlanningState(this.workspace);
      const needle = query.q?.trim().toLocaleLowerCase();
      const plans = state.plans
        .filter(
          (plan) =>
            (!query.status || plan.status === query.status) &&
            (!needle ||
              `${plan.key} ${plan.title} ${plan.summary} ${plan.goal}`
                .toLocaleLowerCase()
                .includes(needle)),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
      return {
        ...planningPage(plans.map(state.summary), query, [
          this.workspace.config.projectId,
          "plans",
          query.q,
          query.status,
          query.limit,
          planningSession(this.workspace).state.version,
          state.plans,
          state.stages,
          state.tasks,
        ]),
        statusCounts: Object.fromEntries(
          ["all", "draft", "active", "completed", "cancelled"].map((status) => [
            status,
            state.plans.filter((plan) => status === "all" || plan.status === status).length,
          ]),
        ),
      };
    });
  }
  async candidates(input: PlanningCandidatesQuery = {}) {
    const query = planningCandidatesQuerySchema.parse(input);
    return this.workspace.locked(async () => {
      const session = planningSession(this.workspace);
      const state = await readPlanningState(this.workspace);
      const boardId = query.board
        ? (await session.resolve(query.board, "board")).ref.id
        : undefined;
      invariant(!query.stage || query.plan, "INVALID_ARGUMENT", "Для этапа укажите его план", 2);
      const plan = query.plan
        ? await planningRecord(this.workspace, query.plan, "work-plan")
        : undefined;
      const stageId = query.stage && plan ? (await this.stage(plan, query.stage)).id : undefined;
      const needle = query.q?.trim().toLocaleLowerCase();
      const selected = state.tasks
        .filter(
          (task) =>
            (!boardId || task.boardId === boardId) &&
            (!needle || `${task.key} ${task.title}`.toLocaleLowerCase().includes(needle)) &&
            (query.availableOnly === "false" ||
              (stageId !== undefined &&
                state.current.get(task.id)?.stageId === stageId &&
                state.current.get(task.id)?.planId === plan?.id) ||
              (!state.current.has(task.id) && task.column !== "cancelled")),
        )
        .sort(
          (a, b) => a.key.localeCompare(b.key, "ru", { numeric: true }) || a.id.localeCompare(b.id),
        );
      const page = planningPage(selected, query, [
        this.workspace.config.projectId,
        "candidates",
        boardId,
        plan?.id,
        stageId,
        query.q,
        query.availableOnly,
        query.limit,
        state.plans,
        state.stages,
        state.tasks,
      ]);
      const service = new BoardTasksService(this.workspace);
      return {
        ...page,
        items: await Promise.all(
          page.items.map(async (task) => {
            const { description: _description, ...summary } = await service.get(task.id);
            const membership = state.current.get(task.id);
            const stage = state.stages.find(
              (entry) => entry.id === membership?.stageId && entry.planId === membership?.planId,
            );
            const plan = stage ? state.plans.find((entry) => entry.id === stage.planId) : undefined;
            return {
              ...summary,
              completed: state.completion.get(task.id)!.completed,
              assignment:
                stage && plan
                  ? {
                      planId: plan.id,
                      planKey: plan.key,
                      planTitle: plan.title,
                      stageId: stage.id,
                      stageTitle: stage.title,
                      status: plan.status,
                      current: true,
                    }
                  : null,
            };
          }),
        ),
      };
    });
  }
  async get(reference: string) {
    return this.workspace.locked(async () => {
      const plan = await planningRecord(this.workspace, reference, "work-plan");
      return (await readPlanningState(this.workspace)).summary(plan);
    });
  }
  async stages(reference: string, query: PlanningPageQuery = {}) {
    return this.workspace.locked(async () => {
      const plan = await planningRecord(this.workspace, reference, "work-plan");
      const state = await readPlanningState(this.workspace);
      const stages = plan.stages;
      return {
        ...planningPage(
          stages.map((stage) => ({ ...stage, counts: state.counts(stage.taskIds) })),
          query,
          [plan, stages, state.tasks, query.limit],
        ),
        planRevision: plan.revision,
      };
    });
  }
  async tasks(reference: string, stageReference: string, query: PlanningPageQuery = {}) {
    return this.workspace.locked(async () => {
      const plan = await planningRecord(this.workspace, reference, "work-plan");
      const stage = await this.stage(plan, stageReference);
      const state = await readPlanningState(this.workspace);
      const page = planningPage(stage.taskIds, query, [plan, stage, state.tasks, query.limit]);
      const service = new BoardTasksService(this.workspace);
      return {
        ...page,
        items: await Promise.all(
          page.items.map(async (id) => {
            const { description: _description, ...task } = await service.get(id);
            return { ...task, completed: state.completion.get(id)!.completed };
          }),
        ),
      };
    });
  }
  async memberships(task: string, query: PlanningPageQuery = {}) {
    return this.workspace.locked(async () => {
      const session = planningSession(this.workspace);
      const ref = await session.resolve(task, "task");
      const plans = await planningRecords(this.workspace, "work-plan");
      const stages = plans.flatMap((plan) =>
        plan.stages.map((stage) => ({ ...stage, planId: plan.id })),
      );
      const items = stages
        .filter((stage) => stage.taskIds.includes(ref.ref.id))
        .map((stage) => {
          const plan = plans.find((entry) => entry.id === stage.planId)!;
          invariant(plan, "INVALID_REFERENCE", "План этапа отсутствует", 4);
          return {
            planId: plan.id,
            planKey: plan.key,
            planTitle: plan.title,
            stageId: stage.id,
            stageTitle: stage.title,
            status: plan.status,
            current: plan.status === "draft" || plan.status === "active",
          };
        })
        .sort((a, b) => Number(b.current) - Number(a.current) || a.planId.localeCompare(b.planId));
      return planningPage(items, query, [
        this.workspace.config.projectId,
        ref.ref,
        items,
        query.limit,
      ]);
    });
  }
  async create(input: CreatePlan, actor: string) {
    const command = createPlanSchema.parse(input);
    return this.write(command, actor, "create", undefined, async (author) => {
      const { requestId, actor: _actor, ...fields } = command;
      await this.fields(fields);
      const plan = await createPlanning(
        this.workspace,
        "work-plan",
        { ...fields, stages: [], status: "draft", result: "", startedAt: null, closedAt: null },
        author,
      );
      await syncPlanRelations(this.workspace, plan, author);
      return planningSaved(plan, "create", requestId);
    });
  }
  async update(reference: string, input: UpdatePlan, actor: string) {
    const command = updatePlanSchema.parse(input);
    return this.write(command, actor, "update", reference, async (author) => {
      const plan = await this.editable(reference, command.ifRevision);
      const { requestId, ifRevision: _revision, actor: _actor, ...fields } = command;
      invariant(Object.keys(fields).length > 0, "INVALID_ARGUMENT", "Изменения плана не заданы", 2);
      const next = workPlanSchema.parse({
        ...plan,
        ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
      });
      await this.fields(next);
      const saved = (await savePlanning(this.workspace, next, author, "update")) as WorkPlan;
      await syncPlanRelations(this.workspace, saved, author);
      return planningSaved(saved, "update", requestId);
    });
  }
  async transition(reference: string, input: TransitionPlan, actor: string) {
    const command = transitionPlanSchema.parse(input);
    return this.write(command, actor, command.action, reference, async (author) => {
      const plan = await this.editable(reference, command.ifRevision);
      const state = await readPlanningState(this.workspace);
      const summary = state.summary(plan);
      if (command.action === "start") {
        invariant(
          plan.status === "draft",
          "INVALID_PLAN_TRANSITION",
          "Начать можно только черновик плана",
          4,
        );
        invariant(
          plan.goal.trim() !== "" && summary.counts.total > 0,
          "PLAN_INCOMPLETE",
          "Для начала нужны цель и хотя бы одна задача",
          4,
        );
        plan.status = "active";
        plan.startedAt = new Date().toISOString();
      } else {
        invariant(
          command.result.trim() !== "",
          "INVALID_ARGUMENT",
          "Опишите итог либо причину отмены",
          2,
        );
        if (command.action === "complete") {
          invariant(
            summary.ready,
            "PLAN_INCOMPLETE",
            "Не выполнен весь состав плана с учётом критериев, детей и зависимостей",
            4,
          );
        }
        plan.status = command.action === "complete" ? "completed" : "cancelled";
        plan.result = command.result;
        plan.closedAt = new Date().toISOString();
      }
      const saved = await savePlanning(this.workspace, plan, author, command.action);
      return planningSaved(saved, command.action, command.requestId);
    });
  }
  async changeStage(reference: string, input: ChangeStage, actor: string) {
    const command = changeStageSchema.parse(input);
    return this.write(command, actor, `stage-${command.action}`, reference, async (author) => {
      const plan = await this.editable(reference, command.ifRevision);
      const stages = plan.stages;
      let stage: PlanStage;
      if (command.action === "create") {
        invariant(
          command.fields && !command.stage && command.before === undefined,
          "INVALID_ARGUMENT",
          "Для создания этапа задайте его содержание",
          2,
        );
        const fields = stageFieldsSchema.parse(command.fields);
        invariant(stages.length < 200, "PLANNING_LIMIT", "В плане допускается до 200 этапов", 4);
        let id = shortId();
        while (stages.some((entry) => entry.id === id)) id = shortId();
        stage = { ...fields, id, taskIds: [] };
        stages.push(stage);
      } else {
        invariant(command.stage, "INVALID_ARGUMENT", "Укажите этап", 2);
        stage = await this.stage(plan, command.stage);
        if (command.action === "update") {
          const fields = Object.fromEntries(
            Object.entries(command.fields ?? {}).filter(([, value]) => value !== undefined),
          );
          invariant(
            Object.keys(fields).length > 0,
            "INVALID_ARGUMENT",
            "Изменения этапа не заданы",
            2,
          );
          Object.assign(stage, fields);
        } else if (command.action === "remove") {
          invariant(
            stage.taskIds.length === 0,
            "STAGE_NOT_EMPTY",
            "Сначала явно исключите или перенесите задачи этапа",
            4,
          );
          plan.stages = stages.filter((entry) => entry.id !== stage.id);
        } else {
          invariant(
            (command.before !== undefined) !== (command.direction !== undefined),
            "INVALID_ARGUMENT",
            "Укажите либо before (ID или null), либо direction",
            2,
          );
          const ordered = stages.filter((entry) => entry.id !== stage.id);
          const position =
            command.direction === undefined
              ? command.before === null
                ? ordered.length
                : ordered.findIndex((entry) => entry.id === command.before)
              : stages.findIndex((entry) => entry.id === stage.id) +
                (command.direction === "up" ? -1 : 1);
          invariant(
            position >= 0 && position <= ordered.length,
            "INVALID_REFERENCE",
            "Этап нельзя переместить за границу либо выбран неизвестный следующий этап",
            4,
          );
          ordered.splice(position, 0, stage);
          plan.stages = ordered;
        }
      }
      const saved = await savePlanning(this.workspace, plan, author, `stage-${command.action}`, {
        stageId: stage.id,
      });
      await syncPlanRelations(this.workspace, saved as WorkPlan, author);
      return {
        ...planningSaved(saved, `stage-${command.action}`, command.requestId),
        stageId: stage.id,
      };
    });
  }
  async changeTasks(reference: string, input: ChangePlanTasks, actor: string) {
    const command = changePlanTasksSchema.parse(input);
    return this.write(command, actor, "tasks", reference, async (author) => {
      const plan = await this.editable(reference, command.ifRevision);
      const stage = await this.stage(plan, command.stage);
      const state = await readPlanningState(this.workspace);
      const session = planningSession(this.workspace);
      const resolve = async (refs: string[]) =>
        Promise.all(refs.map(async (ref) => (await session.resolve(ref, "task")).ref.id));
      const add = await resolve(command.add),
        remove = await resolve(command.remove);
      invariant(
        new Set([...add, ...remove]).size === add.length + remove.length,
        "DUPLICATE_VALUE",
        "Задача повторяется в изменении состава",
        4,
      );
      invariant(
        add.length + remove.length > 0,
        "INVALID_ARGUMENT",
        "Изменения состава не заданы",
        2,
      );
      for (const id of add) {
        invariant(
          !state.current.has(id),
          "TASK_IN_PLAN",
          "Задача уже включена в текущий план; используйте явный перенос",
          4,
          { taskId: id, stageId: state.current.get(id)?.stageId },
        );
        invariant(
          state.byTask.get(id)?.column !== "cancelled",
          "TASK_CANCELLED",
          "Отменённая задача не может быть новым включением",
          4,
        );
      }
      invariant(
        remove.every((id) => stage.taskIds.includes(id)),
        "INVALID_REFERENCE",
        "Исключаемая задача не входит в этап",
        4,
      );
      invariant(
        stage.taskIds.length - remove.length + add.length <= 2000,
        "PLANNING_LIMIT",
        "В этапе допускается до 2000 задач",
        4,
      );
      stage.taskIds = [...stage.taskIds.filter((id) => !remove.includes(id)), ...add];
      const saved = await savePlanning(this.workspace, plan, author, "tasks", {
        stageId: stage.id,
        add,
        remove,
      });
      await syncPlanRelations(this.workspace, saved as WorkPlan, author);
      return planningSaved(saved, "tasks", command.requestId);
    });
  }
  async transfer(reference: string, input: TransferPlanTask, actor: string) {
    const command = transferPlanTaskSchema.parse(input);
    return this.write(command, actor, "transfer", reference, async (author) => {
      invariant(command.reason.trim() !== "", "INVALID_ARGUMENT", "Укажите причину переноса", 2);
      const plan = await this.editable(reference, command.ifRevision);
      const destinationPlan = await this.editable(command.targetPlan, command.targetRevision);
      const targetPlan = destinationPlan.id === plan.id ? plan : destinationPlan;
      const target = await this.stage(targetPlan, command.targetStage);
      invariant(
        target.taskIds.length < 2000,
        "PLANNING_LIMIT",
        "В целевом этапе уже 2000 задач",
        4,
      );
      const taskId = (await planningSession(this.workspace).resolve(command.task, "task")).ref.id;
      const state = await readPlanningState(this.workspace);
      const membership = state.current.get(taskId);
      const source = plan.stages.find((stage) => stage.id === membership?.stageId);
      invariant(
        source &&
          membership?.planId === plan.id &&
          (plan.id !== targetPlan.id || source.id !== target.id),
        "INVALID_REFERENCE",
        "Задача не входит в исходный план либо уже находится в целевом этапе",
        4,
      );
      const details = { taskId, from: source.id, to: target.id, reason: command.reason };
      source.taskIds = source.taskIds.filter((id) => id !== taskId);
      target.taskIds.push(taskId);
      const saved = await savePlanning(this.workspace, plan, author, "transfer", details);
      await syncPlanRelations(this.workspace, saved as WorkPlan, author);
      const destination =
        plan.id === targetPlan.id
          ? saved
          : await savePlanning(this.workspace, targetPlan, author, "transfer", details);
      if (plan.id !== targetPlan.id)
        await syncPlanRelations(this.workspace, destination as WorkPlan, author);
      return {
        ...planningSaved(saved, "transfer", command.requestId),
        targetRevision: destination.revision,
      };
    });
  }
  private async editable(reference: string, revision: number) {
    const plan = await planningRecord(this.workspace, reference, "work-plan");
    assertRevision(plan, revision);
    assertEditable(plan);
    return plan;
  }
  private async stage(plan: WorkPlan, reference: string) {
    const stage = plan.stages.find((entry) => entry.id === reference);
    invariant(stage, "INVALID_REFERENCE", "Этап не найден в выбранном плане", 4);
    return stage;
  }
}
