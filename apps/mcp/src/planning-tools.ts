import { z } from "zod";
import { actorSchema, entityReferenceSchema } from "@relay/contracts/primitives";
import {
  plansQuerySchema,
  planningPageQuerySchema,
  createPlanSchema,
  updatePlanSchema,
  transitionPlanSchema,
  changeStageSchema,
  changePlanTasksSchema,
  transferPlanTaskSchema,
  stageFieldsSchema,
  stageChangesSchema,
  planningWrite,
  planningRevision,
  planningCandidatesQuerySchema,
} from "@relay/contracts/planning";
import type { PlanningSaved } from "@relay/contracts/planning";
import {
  releasesQuerySchema,
  saveReleaseSchema,
  updateReleaseSchema,
  releaseActionSchema,
  releasePreviewSchema,
} from "@relay/contracts/releases";
import { progressQuerySchema } from "@relay/contracts/progress";
import type { Backend } from "@relay/project-runtime/backend/types";
import type { Result } from "./output.js";

/** Предметный инструмент с явными параметрами и общей реализацией Backend. */
type PlanningTool = {
  name: string;
  description: string;
  schema: z.ZodObject;
  readOnly: boolean;
  run: (backend: Backend, input: Record<string, unknown>) => Promise<Result>;
};
const ref = {
  ref: entityReferenceSchema.describe(
    "Ключ или постоянный ID плана либо релиза выбранного проекта",
  ),
};
const write = { ...planningWrite, actor: actorSchema.describe("Автор предметного действия") };
const paging = { ...ref, ...planningPageQuerySchema.shape };
const revision = { ...write, ...ref, ifRevision: planningRevision };
const address = (input: Record<string, unknown>) => entityReferenceSchema.parse(input.ref);
const actor = (input: Record<string, unknown>) => actorSchema.parse(input.actor);
const statusLabels: Record<string, string> = {
  draft: "Черновик",
  active: "В работе",
  completed: "Завершён",
  cancelled: "Отменён",
  planned: "Запланирован",
  released: "Выпущен",
};
const actionLabels: Record<string, string> = {
  create: "Запись создана",
  update: "Изменения сохранены",
  start: "План начат",
  complete: "План завершён",
  cancel: "Отмена сохранена",
  tasks: "Состав задач обновлён",
  transfer: "Задача перенесена",
  release: "Выпуск зафиксирован",
  plan: "Релиз перепланирован",
  "stage-create": "Этап создан",
  "stage-update": "Этап изменён",
  "stage-remove": "Этап удалён",
  "stage-move": "Порядок этапов изменён",
};
const saved = (data: PlanningSaved): Result => ({
  data,
  text: `${data.key}: ${actionLabels[data.action] ?? data.action}. ID: ${data.id}. Ревизия: ${data.revision}. Ключ повтора: ${data.requestId}.${data.stageId ? ` Этап: ${data.stageId}.` : ""}${data.targetRevision ? ` Ревизия целевого плана: ${data.targetRevision}.` : ""}`,
});

/** Инструменты сохраняют одинаковые последствия с Web, REST и local CLI. */
export const planningTools: PlanningTool[] = [
  {
    name: "plan_task_candidates",
    description:
      "Найти задачи для включения в этап: поиск, доска, доступность и текущая принадлежность; серверные страницы",
    schema: planningCandidatesQuerySchema,
    readOnly: true,
    run: async (backend, input) => ({
      data: await backend.plans.candidates(planningCandidatesQuerySchema.parse(input)),
    }),
  },
  {
    name: "plans_list",
    description:
      "Найти планы работ по состоянию и тексту; полные итоги, страницы nextOffset/version",
    schema: plansQuerySchema,
    readOnly: true,
    run: async (backend, input) => ({
      data: await backend.plans.list(plansQuerySchema.parse(input)),
    }),
  },
  {
    name: "plan_get",
    description:
      "Прочитать полные тексты плана и показатели всего состава; этапы читаются отдельно",
    schema: z.strictObject(ref),
    readOnly: true,
    run: async (backend, input) => {
      const data = await backend.plans.get(address(input));
      return {
        data,
        text: `${data.key} · ${data.title}\nСостояние: ${statusLabels[data.status]}. Выполнено задач: ${data.counts.completed}/${data.counts.total}.\n\n${data.goal}`,
      };
    },
  },
  {
    name: "plan_stages_list",
    description: "Прочитать страницу этапов плана в предметном порядке с полными показателями",
    schema: z.strictObject(paging),
    readOnly: true,
    run: async (backend, input) => ({
      data: await backend.plans.stages(
        address(input),
        planningPageQuerySchema.strip().parse(input),
      ),
    }),
  },
  {
    name: "plan_tasks_list",
    description:
      "Прочитать актуальные задачи этапа; задача не копируется в план, полное описание доступно через board_task_get",
    schema: z.strictObject({
      ...paging,
      stage: changePlanTasksSchema.shape.stage,
    }),
    readOnly: true,
    run: async (backend, input) => ({
      data: await backend.plans.tasks(
        address(input),
        entityReferenceSchema.parse(input.stage),
        planningPageQuerySchema.strip().parse(input),
      ),
    }),
  },
  {
    name: "task_plan_memberships",
    description: "Прочитать текущее и историческое участие задачи в планах",
    schema: z.strictObject({
      ...paging,
      ref: entityReferenceSchema.describe("Ключ или ID задачи"),
    }),
    readOnly: true,
    run: async (backend, input) => ({
      data: await backend.plans.memberships(
        address(input),
        planningPageQuerySchema.strip().parse(input),
      ),
    }),
  },
  {
    name: "plan_create",
    description:
      "Создать черновик плана с целью и областью. Бекенд сохраняет отдельные связи Core; задача не начинает исполнение автоматически",
    schema: createPlanSchema.extend(write),
    readOnly: false,
    run: async (backend, input) =>
      saved(await backend.plans.create(createPlanSchema.parse(input), actor(input))),
  },
  {
    name: "plan_update",
    description:
      "Изменить только переданные реквизиты плана с проверкой ревизии; отсутствие поля сохраняет его значение",
    schema: updatePlanSchema.extend({ ...ref, actor: write.actor }),
    readOnly: false,
    run: async (backend, input) =>
      saved(
        await backend.plans.update(
          address(input),
          updatePlanSchema.strip().parse(input),
          actor(input),
        ),
      ),
  },
  {
    name: "plan_tasks_include",
    description:
      "Включить выбранные задачи в этап; допускается одна текущая принадлежность, колонки задач не меняются",
    schema: z.strictObject({
      ...revision,
      stage: changePlanTasksSchema.shape.stage,
      tasks: changePlanTasksSchema.shape.add
        .removeDefault()
        .describe("Ключи или ID включаемых задач, максимум 2000"),
    }),
    readOnly: false,
    run: async (backend, input) =>
      saved(
        await backend.plans.changeTasks(
          address(input),
          changePlanTasksSchema.strip().parse({ ...input, add: input.tasks }),
          actor(input),
        ),
      ),
  },
  {
    name: "plan_tasks_exclude",
    description:
      "Явно исключить задачи из этапа и снять соответствующие связи Core, сохранив остальные включения и сами задачи",
    schema: z.strictObject({
      ...revision,
      stage: changePlanTasksSchema.shape.stage,
      tasks: changePlanTasksSchema.shape.remove
        .removeDefault()
        .describe("Ключи или ID исключаемых задач, максимум 2000"),
    }),
    readOnly: false,
    run: async (backend, input) =>
      saved(
        await backend.plans.changeTasks(
          address(input),
          changePlanTasksSchema.strip().parse({ ...input, remove: input.tasks }),
          actor(input),
        ),
      ),
  },
  {
    name: "plan_task_transfer",
    description:
      "Перенести задачу между этапами или планами с причиной и ревизиями обоих планов; обе стороны согласуются одной операцией",
    schema: transferPlanTaskSchema.extend({ ...ref, actor: write.actor }),
    readOnly: false,
    run: async (backend, input) =>
      saved(
        await backend.plans.transfer(
          address(input),
          transferPlanTaskSchema.strip().parse(input),
          actor(input),
        ),
      ),
  },
  {
    name: "releases_list",
    description:
      "Найти самостоятельные релизы по названию, ключу, версии и состоянию; страницы nextOffset/version",
    schema: releasesQuerySchema,
    readOnly: true,
    run: async (backend, input) => ({
      data: await backend.releases.list(releasesQuerySchema.parse(input)),
    }),
  },
  {
    name: "release_get",
    description: "Прочитать реквизиты релиза, текущую готовность и сведения о состоявшемся выпуске",
    schema: z.strictObject(ref),
    readOnly: true,
    run: async (backend, input) => {
      const data = await backend.releases.get(address(input));
      return {
        data,
        text: `${data.key} · ${data.title}\nВерсия: ${data.version}. Состояние: ${statusLabels[data.status]}.\nТекущая готовность: ${data.readiness.ready}/${data.readiness.total} планов.\nВыпущен: ${data.releasedAt ?? "—"}. Автор выпуска: ${data.releasedBy ?? "—"}.\n\n${data.description}`,
      };
    },
  },
  {
    name: "release_plans_list",
    description: "Прочитать актуальные планы состава независимо от состояния выпуска",
    schema: z.strictObject(paging),
    readOnly: true,
    run: async (backend, input) => ({
      data: await backend.releases.composition(
        address(input),
        planningPageQuerySchema.strip().parse(input),
      ),
    }),
  },
  {
    name: "release_preview",
    description:
      "Прочитать готовность выбранных планов без создания релиза; незавершённые планы можно планировать",
    schema: releasePreviewSchema,
    readOnly: true,
    run: async (backend, input) => ({
      data: await backend.releases.preview(releasePreviewSchema.parse(input)),
    }),
  },
  {
    name: "release_create",
    description:
      "Создать самостоятельный релиз с планами и статусом. released проверяет готовность и фиксирует выпуск, не запускает CI/CD",
    schema: saveReleaseSchema.omit({ ifRevision: true }).extend(write),
    readOnly: false,
    run: async (backend, input) =>
      saved(await backend.releases.create(saveReleaseSchema.parse(input), actor(input))),
  },
  {
    name: "release_update",
    description:
      "Сохранить полные реквизиты, состав и выбранное состояние одной операцией с проверкой ревизии; выпущенный релиз неизменяем",
    schema: updateReleaseSchema.extend(revision),
    readOnly: false,
    run: async (backend, input) =>
      saved(
        await backend.releases.update(
          address(input),
          updateReleaseSchema.strip().parse(input),
          actor(input),
        ),
      ),
  },
];

for (const action of ["start", "complete", "cancel"] as const)
  planningTools.push({
    name: `plan_${action}`,
    description: {
      start: "Явно начать черновик с целью и непустым составом; колонки задач не меняются",
      complete:
        "Завершить готовый план с итогом без обязательного начала; Core повторно проверяет фактическое выполнение всех обязательств",
      cancel: "Отменить план с причиной, сохранив историю включений и сами задачи",
    }[action],
    schema: z.strictObject({
      ...revision,
      ...(action === "start"
        ? {}
        : {
            result: transitionPlanSchema.shape.result
              .removeDefault()
              .min(1)
              .describe("Итог завершения либо причина отмены в Markdown"),
          }),
    }),
    readOnly: false,
    run: async (backend, input) =>
      saved(
        await backend.plans.transition(
          address(input),
          transitionPlanSchema.strip().parse({ ...input, action }),
          actor(input),
        ),
      ),
  });
for (const action of ["create", "update", "remove", "move"] as const)
  planningTools.push({
    name: `plan_stage_${action}`,
    description: {
      create:
        "Создать этап плана с ожидаемым результатом; все содержательные поля доступны напрямую",
      update:
        "Изменить только переданные поля этапа с проверкой ревизии плана. Укажите хотя бы одно поле; название необязательно. Пустая строка очищает краткое описание, результат или условия завершения",
      remove: "Удалить пустую запись этапа из плана; задачи предварительно исключаются явно",
      move: "Изменить порядок этапа по ID следующего этапа, null — конец полного списка",
    }[action],
    schema: z.strictObject({
      ...revision,
      ...(action === "create" ? {} : { stage: changePlanTasksSchema.shape.stage }),
      ...(action === "create"
        ? stageFieldsSchema.shape
        : action === "update"
          ? stageChangesSchema.shape
          : {}),
      ...(action === "move"
        ? {
            before: changeStageSchema.shape.before
              .unwrap()
              .describe("ID следующего этапа в полном списке; null — поместить в конец"),
          }
        : {}),
    }),
    readOnly: false,
    run: async (backend, input) =>
      saved(
        await backend.plans.changeStage(
          address(input),
          changeStageSchema.strip().parse({
            ...input,
            action,
            ...(action === "create"
              ? { fields: stageFieldsSchema.strip().parse(input) }
              : action === "update"
                ? { fields: stageChangesSchema.strip().parse(input) }
                : {}),
          }),
          actor(input),
        ),
      ),
  });
for (const action of ["plan", "cancel", "release"] as const)
  planningTools.push({
    name: action === "release" ? "release_publish" : `release_${action}`,
    description: {
      plan: "Явно перепланировать отменённый релиз",
      cancel: "Отменить плановый релиз, сохранив планы и задачи",
      release:
        "Зафиксировать выпуск: проверить готовность, сохранить автора и дату одной восстанавливаемой операцией",
    }[action],
    schema: z.strictObject(revision),
    readOnly: false,
    run: async (backend, input) =>
      saved(
        await backend.releases.transition(
          address(input),
          releaseActionSchema.strip().parse({ ...input, action }),
          actor(input),
        ),
      ),
  });
for (const kind of ["workPlan", "release"] as const)
  planningTools.push({
    name: kind === "workPlan" ? "work_plan_progress" : "release_progress",
    description:
      kind === "workPlan"
        ? "Прочитать прогресс плана, этапы, причины и расхождение с сохранённым завершением"
        : "Прочитать текущую готовность выбранных планов; статус выпуска не меняется автоматически",
    schema: progressQuerySchema,
    readOnly: true,
    run: async (backend, input) => {
      const data = await backend.progress[kind](progressQuerySchema.parse(input));
      return {
        data,
        text: `${data.entity.title}: ${data.completed ? "выполнено" : "не выполнено"}. Причин: ${data.reasons.total}. ${data.reasons.items.map((reason) => reason.message).join("; ")}`,
      };
    },
  });
