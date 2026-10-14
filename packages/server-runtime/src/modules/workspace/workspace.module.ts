import { Global, Inject, Injectable, Module, Scope } from "@nestjs/common";
import type { DynamicModule } from "@nestjs/common";
import { REQUEST } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import type { OpenWorkspaceOptions, Workspace } from "@relay/core/storage/workspace";
import { ProjectCatalog } from "./catalog.js";
import type { ProjectContext, WorkspaceOptions } from "./catalog.js";
import { PROJECT_SELECTOR } from "./routing.js";
import type { SaveProjectSettings } from "@relay/core/domain/project-settings";

export type { WorkspaceOptions } from "./catalog.js";

/** Контекст запроса никогда не разделяется между параллельными клиентами. */
@Injectable({ scope: Scope.REQUEST })
export class WorkspaceService {
  private project: Promise<ProjectContext> | undefined;
  private selected: ProjectContext | undefined;
  constructor(
    @Inject(ProjectCatalog) private readonly catalog: ProjectCatalog,
    @Inject(REQUEST) private readonly request: FastifyRequest,
  ) {}

  async resolve(options: OpenWorkspaceOptions = {}): Promise<ProjectContext> {
    const raw = this.request.raw as typeof this.request.raw & { [PROJECT_SELECTOR]?: string };
    this.project ??= this.catalog.select(raw[PROJECT_SELECTOR], options);
    this.selected = await this.project;
    return this.selected;
  }

  async open(options: OpenWorkspaceOptions = {}) {
    return (await this.resolve(options)).open(options);
  }

  /** Сохраняет имя и адрес выбранного проекта с проверкой каталога. */
  async saveSettings(input: SaveProjectSettings) {
    return this.catalog.saveSettings(await this.resolve(), input);
  }

  context(workspace: Workspace) {
    if (!this.selected) throw new Error("Контекст проекта ещё не разрешён");
    return this.selected.context(workspace);
  }

  mutation(input: { actor?: string; ifRevision?: number }) {
    return {
      actor: this.catalog.actor(input.actor),
      ...(input.ifRevision === undefined ? {} : { ifRevision: input.ifRevision }),
    };
  }

  actor(override?: string) {
    return this.catalog.actor(override);
  }
}

@Global()
@Module({})
export class WorkspaceModule {
  static register(options: WorkspaceOptions): DynamicModule {
    return {
      module: WorkspaceModule,
      providers: [
        { provide: ProjectCatalog, useValue: new ProjectCatalog(options) },
        WorkspaceService,
      ],
      exports: [ProjectCatalog, WorkspaceService],
    };
  }
}
