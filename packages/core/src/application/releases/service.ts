import {
  releasesQuerySchema,
  saveReleaseSchema,
  updateReleaseSchema,
  releaseActionSchema,
  releasePreviewSchema,
} from "@relay/contracts/releases";
import type {
  Release,
  SaveRelease,
  UpdateRelease,
  ReleaseAction,
  ReleasesQuery,
  ReleasePreview,
} from "@relay/contracts/releases";
import type { PlanningPageQuery } from "@relay/contracts/planning";
import { actorSchema } from "@relay/contracts/primitives";
import type { Workspace } from "../../storage/workspace.js";
import {
  planningSession,
  planningRecords,
  planningRecord,
  createPlanning,
  savePlanning,
  planningPage,
  planningSaved,
  assertRevision,
} from "../../storage/planning.js";
import { invariant } from "../../shared/errors.js";
import { readPlanningState } from "../planning/model.js";
import { releaseComposition } from "./model.js";
import { syncReleaseRelations } from "./relations.js";

/** Самостоятельный владелец выпуска; планы и задачи не меняют состояния вслед за релизом. */
export class ReleasesService {
  constructor(readonly workspace: Workspace) {}

  async list(input: ReleasesQuery = {}) {
    const query = releasesQuerySchema.parse(input);
    return this.workspace.locked(async () => {
      planningSession(this.workspace);
      const releases = await planningRecords(this.workspace, "release");
      const needle = query.q?.trim().toLocaleLowerCase();
      const selected = releases
        .filter(
          (release) =>
            (!query.status || release.status === query.status) &&
            (!needle ||
              `${release.key} ${release.title} ${release.version} ${release.summary}`
                .toLocaleLowerCase()
                .includes(needle)),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
      const source = [
        this.workspace.config.projectId,
        "releases",
        query.q,
        query.status,
        query.limit,
        planningSession(this.workspace).state.version,
      ];
      const page = planningPage(selected, query, source);
      const state = await readPlanningState(this.workspace);
      const items = await Promise.all(
        page.items.map(async (release) => {
          const readiness = releaseComposition(release.planIds, state).readiness;
          return {
            ...release,
            readiness: {
              ...readiness,
              canRelease: release.status === "planned" && readiness.canRelease,
            },
          };
        }),
      );
      return {
        ...page,
        items,
        statusCounts: Object.fromEntries(
          ["all", "planned", "released", "cancelled"].map((status) => [
            status,
            releases.filter((release) => status === "all" || release.status === status).length,
          ]),
        ),
      };
    });
  }
  async get(reference: string) {
    return this.workspace.locked(async () => {
      const release = await planningRecord(this.workspace, reference, "release");
      const readiness = releaseComposition(
        release.planIds,
        await readPlanningState(this.workspace),
      ).readiness;
      return {
        ...release,
        readiness: {
          ...readiness,
          canRelease: release.status === "planned" && readiness.canRelease,
        },
      };
    });
  }
  async composition(reference: string, query: PlanningPageQuery = {}) {
    return this.workspace.locked(async () => {
      const release = await planningRecord(this.workspace, reference, "release");
      const state = await readPlanningState(this.workspace);
      const result = releaseComposition(release.planIds, state);
      return {
        ...planningPage(result.items, query, [
          release,
          planningSession(this.workspace).state.version,
          state.plans,
          state.stages,
          state.tasks,
          query.limit,
        ]),
        readiness: {
          ...result.readiness,
          canRelease: release.status === "planned" && result.readiness.canRelease,
        },
      };
    });
  }
  async preview(input: ReleasePreview) {
    const query = releasePreviewSchema.parse(input);
    return this.workspace.locked(async () => {
      const ids = await this.resolvePlans(query.plans);
      const state = await readPlanningState(this.workspace);
      const result = releaseComposition(ids, state);
      return {
        ...planningPage(result.items, query, [
          this.workspace.config.projectId,
          "preview",
          ids,
          planningSession(this.workspace).state.version,
          state.plans,
          state.stages,
          state.tasks,
          query.limit,
        ]),
        readiness: result.readiness,
      };
    });
  }
  async create(input: SaveRelease, actor: string) {
    const command = saveReleaseSchema.parse(input);
    invariant(
      command.ifRevision === undefined,
      "INVALID_ARGUMENT",
      "Создание не принимает ревизию существующего релиза",
      2,
    );
    return this.save(undefined, command, actor);
  }
  async update(reference: string, input: UpdateRelease, actor: string) {
    return this.save(reference, updateReleaseSchema.parse(input), actor);
  }
  private async save(
    reference: string | undefined,
    command: ReturnType<typeof saveReleaseSchema.parse>,
    actor: string,
  ) {
    const author = actorSchema.parse(command.actor ?? actor);
    return this.workspace.mutate(
      "release",
      { ...command, operation: "save", ...(reference === undefined ? {} : { reference }) },
      author,
      async () => {
        planningSession(this.workspace);
        const previous =
          reference === undefined
            ? undefined
            : await planningRecord(this.workspace, reference, "release");
        if (previous) {
          invariant(
            command.ifRevision !== undefined,
            "REVISION_REQUIRED",
            "Для изменения нужна ревизия релиза",
            4,
          );
          assertRevision(previous, command.ifRevision);
          invariant(
            previous.status !== "released",
            "RELEASE_IMMUTABLE",
            "Выпущенный релиз неизменяем",
            4,
          );
          invariant(
            previous.status !== "cancelled" || command.status !== "released",
            "INVALID_RELEASE_TRANSITION",
            "Сначала явно перепланируйте отменённый релиз",
            4,
          );
        }
        const { actor: _actor, requestId, ifRevision: _revision, status, ...fields } = command;
        const planIds = await this.resolvePlans(fields.planIds);
        const state = await readPlanningState(this.workspace);
        for (const id of planIds.filter((id) => !previous?.planIds.includes(id)))
          invariant(
            state.plans.find((plan) => plan.id === id)?.status !== "cancelled",
            "PLAN_CLOSED",
            "Отменённый план нельзя включить в новый состав",
            4,
          );
        let release = previous
          ? { ...previous, ...fields, planIds }
          : await createPlanning(
              this.workspace,
              "release",
              {
                ...fields,
                planIds,
                status: "planned",
                releasedAt: null,
                releasedBy: null,
              },
              author,
            );
        release.status = status;
        if (status === "released") {
          this.assertReady(release, state);
          release.releasedAt = new Date().toISOString();
          release.releasedBy = author;
        }
        if (previous || status !== "planned")
          release = (await savePlanning(
            this.workspace,
            release,
            author,
            status === "released" ? "release" : previous ? "update" : "cancel",
          )) as Release;
        await syncReleaseRelations(this.workspace, release, author);
        return planningSaved(
          release,
          status === "released" ? "release" : previous ? "update" : "create",
          requestId,
        );
      },
    );
  }
  async transition(reference: string, input: ReleaseAction, actor: string) {
    const command = releaseActionSchema.parse(input);
    const author = actorSchema.parse(command.actor ?? actor);
    return this.workspace.mutate(
      "release",
      { ...command, operation: "transition", reference },
      author,
      async () => {
        const release = await planningRecord(this.workspace, reference, "release");
        assertRevision(release, command.ifRevision);
        invariant(
          release.status !== "released",
          "RELEASE_IMMUTABLE",
          "Состоявшийся выпуск неизменяем",
          4,
        );
        if (command.action === "release") {
          invariant(
            release.status === "planned",
            "INVALID_RELEASE_TRANSITION",
            "Сначала явно перепланируйте отменённый релиз",
            4,
          );
          release.status = "released";
          this.assertReady(release, await readPlanningState(this.workspace));
          release.releasedAt = new Date().toISOString();
          release.releasedBy = author;
        } else {
          const next = command.action === "plan" ? "planned" : "cancelled";
          invariant(
            release.status !== next,
            "INVALID_RELEASE_TRANSITION",
            "Релиз уже находится в выбранном состоянии",
            4,
          );
          release.status = next;
        }
        const saved = await savePlanning(this.workspace, release, author, command.action);
        return planningSaved(saved, command.action, command.requestId);
      },
    );
  }
  private assertReady(release: Release, state: Awaited<ReturnType<typeof readPlanningState>>) {
    invariant(
      releaseComposition(release.planIds, state).readiness.canRelease,
      "RELEASE_INCOMPLETE",
      "Сначала завершите все планы и их текущие обязательства",
      4,
    );
  }
  private async resolvePlans(refs: string[]) {
    const session = planningSession(this.workspace);
    const ids = await Promise.all(
      refs.map(async (ref) => (await session.resolve(ref, "work-plan")).ref.id),
    );
    invariant(
      new Set(ids).size === ids.length,
      "DUPLICATE_VALUE",
      "План повторяется в составе релиза",
      4,
    );
    return ids;
  }
}
