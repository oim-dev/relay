import { Body, Controller, Get, Inject, Module, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { success } from "@relay/contracts";
import type { ApiSuccess, ContextResponse } from "@relay/contracts";
import { WorkspaceService } from "../workspace/workspace.module.js";
import { ApiEndpoint } from "../../openapi/endpoint.js";
import { projectSettings } from "@relay/core/storage/project-settings";
import { saveProjectSettingsSchema } from "@relay/core/domain/project-settings";
import type { SaveProjectSettings } from "@relay/core/domain/project-settings";
import { ZodValidationPipe } from "../../common/validation.js";

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
    return success(this.workspace.context(await this.workspace.open()));
  }

  @Get("settings")
  @ApiEndpoint({
    id: "getProjectSettings",
    summary: "Получить имя, slug и ревизию настроек проекта",
    response: "ProjectSettings",
  })
  async settings() {
    const workspace = await this.workspace.open();
    return success(projectSettings(workspace.config, workspace.configPath));
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
