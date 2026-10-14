import { Body, Controller, Delete, Get, Inject, Module, Param, Put, Query } from "@nestjs/common";
import { ApiParam, ApiTags } from "@nestjs/swagger";
import { success } from "@relay/contracts";
import { z } from "zod";
import { parse } from "@relay/core/domain/validation";
import { projectEntrySchema, projectNameSchema } from "@relay/project-runtime/config";
import { ApiEndpoint } from "../../openapi/endpoint.js";
import { ProjectCatalog } from "./catalog.js";
import {
  PROJECT_CATALOG_CAPABILITY,
  projectCatalogPageQuerySchema,
} from "@relay/contracts/server-context";

@ApiTags("server")
@Controller("server")
class ServerController {
  constructor(@Inject(ProjectCatalog) private readonly catalog: ProjectCatalog) {}

  @Get()
  @ApiEndpoint({
    id: "getServerContext",
    summary: "Режим Relay и доступные проекты",
    response: "ServerContextResponse",
  })
  async context() {
    return success(await this.catalog.context());
  }

  @Get("capabilities")
  @ApiEndpoint({
    id: "getServerCapabilities",
    summary: "Возможности серверного каталога без чтения проектных баз",
    response: "ServerCapabilities",
  })
  capabilities() {
    return success({ capabilities: [PROJECT_CATALOG_CAPABILITY] });
  }
}

@ApiTags("projects")
@Controller("projects")
class ProjectsController {
  constructor(@Inject(ProjectCatalog) private readonly catalog: ProjectCatalog) {}

  @Get()
  @ApiEndpoint({ id: "getProjects", summary: "Проекты сервера", response: "ServerContextResponse" })
  async list() {
    return success(await this.catalog.context());
  }

  @Get("page")
  @ApiEndpoint({
    id: "getProjectCatalogPage",
    summary: "Страница регистраций с проверкой версии полного каталога; не исторический снимок",
    query: "ProjectCatalogPageQuery",
    response: "ProjectCatalogPage",
  })
  async page(@Query() query: unknown) {
    return success(
      await this.catalog.page(parse(projectCatalogPageQuerySchema, query, "страница каталога")),
    );
  }

  @Put(":project/registration")
  @ApiParam({
    name: "project",
    type: String,
    description: "Ключ регистрации workspace, не projectId или slug",
  })
  @ApiEndpoint({
    id: "registerProjectCompact",
    summary: "Сохранить регистрацию с компактной квитанцией без полного каталога",
    body: "RegisterProjectRequest",
    response: "ProjectRegistrationReceipt",
  })
  async registerCompact(@Param("project") project: string, @Body() input: unknown) {
    const { replace, ...entry } = parse(
      projectEntrySchema.safeExtend({ replace: z.boolean().default(false) }),
      input,
      "регистрация проекта",
    );
    const saved = await this.catalog.register(
      parse(projectNameSchema, project, "проект"),
      entry,
      replace,
    );
    return success({
      action: "register" as const,
      key: saved.project,
      configPath: saved.configPath,
      entry: {
        ...(saved.path === undefined ? {} : { path: saved.path }),
        ...(saved.config === undefined ? {} : { config: saved.config }),
      },
    });
  }

  @Delete(":project/registration")
  @ApiParam({
    name: "project",
    type: String,
    description: "Ключ регистрации workspace, не projectId или slug",
  })
  @ApiEndpoint({
    id: "unregisterProjectCompact",
    summary: "Удалить регистрацию с компактной квитанцией, сохранив файлы базы",
    response: "ProjectUnregistrationReceipt",
  })
  async unregisterCompact(@Param("project") project: string) {
    const removed = await this.catalog.unregister(parse(projectNameSchema, project, "проект"));
    return success({
      action: "unregister" as const,
      key: removed.project,
      configPath: removed.configPath,
      removed: removed.removed,
    });
  }

  @Put(":project")
  @ApiParam({ name: "project", type: String })
  @ApiEndpoint({
    id: "registerProject",
    summary: "Зарегистрировать проект workspace",
    body: "RegisterProjectRequest",
    response: "ServerContextResponse",
  })
  async register(@Param("project") project: string, @Body() input: unknown) {
    const { replace, ...entry } = parse(
      projectEntrySchema.safeExtend({ replace: z.boolean().default(false) }),
      input,
      "регистрация проекта",
    );
    await this.catalog.register(parse(projectNameSchema, project, "проект"), entry, replace);
    return success(await this.catalog.context());
  }

  @Delete(":project")
  @ApiParam({ name: "project", type: String })
  @ApiEndpoint({
    id: "unregisterProject",
    summary: "Удалить регистрацию проекта",
    response: "ServerContextResponse",
  })
  async unregister(@Param("project") project: string) {
    await this.catalog.unregister(parse(projectNameSchema, project, "проект"));
    return success(await this.catalog.context());
  }
}

@Module({ controllers: [ServerController, ProjectsController] })
export class ServerModule {}
