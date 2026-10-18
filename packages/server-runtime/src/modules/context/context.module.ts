import { Body, Controller, Get, Inject, Module, Put, Post, HttpCode } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { success } from "@relay/contracts";
import type { ApiSuccess, ContextResponse } from "@relay/contracts";
import { WorkspaceService } from "../workspace/workspace.module.js";
import { ApiEndpoint } from "../../openapi/endpoint.js";
import { projectSettings } from "@relay/core/storage/project-settings";
import { saveProjectSettingsSchema } from "@relay/core/domain/project-settings";
import type { SaveProjectSettings } from "@relay/core/domain/project-settings";
import { ZodValidationPipe } from "../../common/validation.js";
import { synchronizationStatus } from "@relay/project-runtime/git-storage/status";
import { requestSynchronization } from "@relay/project-runtime/git-storage/launcher";
import { marker } from "@relay/project-runtime/git-storage/state";
import { synchronizationRequestSchema } from "@relay/contracts/synchronization";

@ApiTags("context")
@Controller("context")
class ContextController {
  constructor(@Inject(WorkspaceService) private readonly workspace: WorkspaceService) {}

  @Get()
  @ApiEndpoint({
    id: "getContext",
    summary: "Получить проект, автора и конфигурацию",
    response: "ContextResponse",
  })
  async get(): Promise<ApiSuccess<ContextResponse>> {
    const workspace = await this.workspace.open({ createLegacyDirectories: false });
    return success({
      ...this.workspace.context(workspace),
      synchronizationMode: (await marker(workspace.dataRoot)) ? "git" : "file",
    });
  }

  @Get("settings")
  @ApiEndpoint({
    id: "getProjectSettings",
    summary: "Получить имя, slug и ревизию настроек проекта",
    response: "ProjectSettings",
  })
  async settings() {
    const workspace = await this.workspace.open({ createLegacyDirectories: false });
    return success(projectSettings(workspace.config, workspace.configPath));
  }

  @Get("sync")
  @ApiEndpoint({
    id: "getSynchronizationStatus",
    summary:
      "Прочитать локальный статус фоновой синхронизации и очередь коммитов без обращения к origin",
    response: "SynchronizationStatus",
  })
  async synchronization() {
    const workspace = await this.workspace.open({ createLegacyDirectories: false });
    return success(await synchronizationStatus(workspace.dataRoot));
  }

  @Post("sync")
  @HttpCode(202)
  @ApiEndpoint({
    id: "requestSynchronization",
    summary:
      "Запросить фоновую синхронизацию; ответ не ожидает сеть, локальная работа продолжается",
    response: "SynchronizationStatus",
    body: "SynchronizationRequest",
    status: 202,
  })
  async requestSynchronization(
    @Body(new ZodValidationPipe(synchronizationRequestSchema)) _input: Record<string, never>,
  ) {
    const workspace = await this.workspace.open({ createLegacyDirectories: false });
    if (await marker(workspace.dataRoot)) await requestSynchronization(workspace.dataRoot);
    return success(await synchronizationStatus(workspace.dataRoot));
  }

  @Put("settings")
  @ApiEndpoint({
    id: "saveProjectSettings",
    summary: "Сохранить текущие имя и slug проекта",
    response: "ProjectSettings",
    body: "SaveProjectSettings",
  })
  async save(@Body(new ZodValidationPipe(saveProjectSettingsSchema)) input: SaveProjectSettings) {
    return success(await this.workspace.saveSettings(input));
  }
}

@Module({ controllers: [ContextController] })
export class ContextModule {}
