import {
  taskProgressSchema,
  implementationProgressSchema,
  scenarioProgressSchema,
  featureProgressSchema,
  applicationProgressSchema,
  productProgressSchema,
  releaseProgressSchema,
  progressQuerySchema,
} from "@relay/contracts/progress";
import type { ProgressQuery, ProgressPageQuery } from "@relay/contracts/progress";
import type { Workspace } from "../../storage/workspace.js";
import { PlanningService } from "../planning/service.js";
import { workPlanProgress } from "./planning.js";
import { ReleasesService } from "../releases/service.js";
import type { ProgressReason } from "@relay/contracts/progress";
import { readPlanningState } from "../planning/model.js";
import { AppError } from "../../shared/errors.js";
import { readProgressSnapshot } from "./snapshot.js";
import {
  taskProgress,
  implementationProgress,
  scenarioProgress,
  featureProgress,
  applicationProgress,
  productProgress,
} from "./handlers.js";

/** Отдельные предметные обработчики; каждый ответ строится под общей блокировкой проекта. */
export class ProgressService {
  constructor(private readonly workspace: Workspace) {}

  async task(input: ProgressQuery) {
    return this.workspace.locked(async () => {
      const result = taskProgress(await readProgressSnapshot(this.workspace, "task", input));
      const memberships = this.workspace.storageSession
        ? await new PlanningService(this.workspace).memberships(result.entity.id, { limit: 1 })
        : null;
      return taskProgressSchema.parse({
        ...result,
        planning: memberships?.items.find((item) => item.current) ?? null,
      });
    });
  }
  async workPlan(input: ProgressQuery) {
    return this.planningRead(() => workPlanProgress(this.workspace, input));
  }
  async release(input: ProgressQuery) {
    const query = progressQuerySchema.parse(input);
    return this.planningRead(async () => {
      const service = new ReleasesService(this.workspace);
      const release = await service.get(query.ref);
      const composition = await service.composition(release.id, query);
      const entity = {
        kind: "release" as const,
        id: release.id,
        key: release.key,
        title: release.title,
      };
      const reasons: ProgressReason[] = [];
      if (release.readiness.ready !== release.readiness.total)
        reasons.push({
          code: "PLAN_NOT_COMPLETED",
          source: entity,
          message: "Не все планы завершены и фактически готовы; раскройте состав релиза",
        });
      if (release.status === "cancelled")
        reasons.push({ code: "INACTIVE", source: entity, message: "Релиз отменён" });
      const current = await readPlanningState(this.workspace);
      const plans = current.plans
        .filter((plan) => release.planIds.includes(plan.id))
        .map(current.summary);
      for (const id of release.planIds) {
        const plan = plans.find((entry) => entry.id === id);
        if (!plan)
          reasons.push({ code: "MISSING_PLAN", source: entity, message: `План ${id} недоступен` });
        else if (plan.status !== "completed" || !plan.ready)
          reasons.push({
            code: plan.status === "cancelled" ? "PLAN_CANCELLED" : "PLAN_NOT_COMPLETED",
            source: { kind: "work-plan", id: plan.id, key: plan.key, title: plan.title },
            message: `План ${plan.key} не завершён либо его обязательства больше не выполнены`,
          });
      }
      return releaseProgressSchema.parse({
        kind: "release",
        entity,
        version: composition.version,
        status: release.status,
        completed:
          release.status !== "cancelled" &&
          composition.readiness.ready === composition.readiness.total &&
          composition.readiness.total > 0,
        readiness: release.readiness,
        plans: {
          total: composition.total,
          nextOffset: composition.nextOffset,
          items: composition.items.flatMap(({ plan }) =>
            plan
              ? [
                  {
                    kind: "work-plan" as const,
                    id: plan.id,
                    key: plan.key,
                    title: plan.title,
                    status: plan.status,
                    completed: plan.status === "completed" && plan.ready,
                  },
                ]
              : [],
          ),
        },
        reasons: {
          items: reasons.slice(query.offset, query.offset + query.limit),
          total: reasons.length,
          nextOffset:
            query.offset + query.limit < reasons.length ? query.offset + query.limit : null,
        },
      });
    });
  }
  private async planningRead<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await this.workspace.locked(operation);
    } catch (error) {
      if (error instanceof AppError && error.code === "PLANNING_CHANGED")
        throw new AppError(
          "PROGRESS_CHANGED",
          "Прогресс изменился. Начните чтение с первой страницы",
          4,
        );
      throw error;
    }
  }
  async implementation(input: ProgressQuery) {
    return this.workspace.locked(async () =>
      implementationProgressSchema.parse(
        implementationProgress(await readProgressSnapshot(this.workspace, "implementation", input)),
      ),
    );
  }
  async scenario(input: ProgressQuery) {
    return this.workspace.locked(async () =>
      scenarioProgressSchema.parse(
        scenarioProgress(await readProgressSnapshot(this.workspace, "scenario", input)),
      ),
    );
  }
  async feature(input: ProgressQuery) {
    return this.workspace.locked(async () =>
      featureProgressSchema.parse(
        featureProgress(await readProgressSnapshot(this.workspace, "feature", input)),
      ),
    );
  }
  async application(input: ProgressQuery) {
    return this.workspace.locked(async () =>
      applicationProgressSchema.parse(
        applicationProgress(await readProgressSnapshot(this.workspace, "application", input)),
      ),
    );
  }
  async product(input: ProgressPageQuery = {}) {
    return this.workspace.locked(async () =>
      productProgressSchema.parse(
        productProgress(await readProgressSnapshot(this.workspace, "product", input)),
      ),
    );
  }
}
