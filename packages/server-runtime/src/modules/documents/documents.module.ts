import { Body, Controller, Get, HttpCode, Inject, Module, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { success } from "@relay/contracts";
import {
  documentLinksQuerySchema,
  documentSectionsQuerySchema,
  documentRelationChangeSchema,
  documentSectionChangeSchema,
} from "@relay/contracts/document-library";
import type {
  DocumentLinksQuery,
  DocumentSectionsQuery,
  DocumentRelationChange,
  DocumentSectionChange,
} from "@relay/contracts/document-library";
import { DocumentLibraryService } from "@relay/core/application/documents/library";
import { ApiEndpoint } from "../../openapi/endpoint.js";
import { ZodValidationPipe } from "../../common/validation.js";
import { WorkspaceService } from "../workspace/workspace.module.js";
import { EventsService } from "../events/events.service.js";
import { EventsModule } from "../events/events.module.js";

@ApiTags("documents")
@Controller("documents")
class DocumentsController {
  constructor(
    @Inject(WorkspaceService) private readonly workspace: WorkspaceService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  private async library() {
    return new DocumentLibraryService(await this.workspace.open());
  }

  private async changed<T>(operation: (library: DocumentLibraryService) => Promise<T>) {
    const workspace = await this.workspace.open();
    const result = await operation(new DocumentLibraryService(workspace));
    await this.events.apiChanged(workspace.config.projectId).catch(() => {});
    return success(result);
  }

  @Get("links")
  @ApiEndpoint({
    id: "getDocumentLinks",
    summary:
      "Прочитать страницу прикреплений документа без его текста; до 100 связей с версией продолжения",
    query: "DocumentLinksQuery",
    response: "DocumentLinksPage",
  })
  async links(@Query(new ZodValidationPipe(documentLinksQuerySchema)) query: DocumentLinksQuery) {
    return success(await (await this.library()).links(query));
  }

  @Get("sections")
  @ApiEndpoint({
    id: "getDocumentSections",
    summary: "Прочитать страницу разделов библиотеки с ревизией проекта и версией продолжения",
    query: "DocumentSectionsQuery",
    response: "DocumentSectionsPage",
  })
  async sections(
    @Query(new ZodValidationPipe(documentSectionsQuerySchema)) query: DocumentSectionsQuery,
  ) {
    return success(await (await this.library()).sections(query));
  }

  @Post("relations")
  @HttpCode(200)
  @ApiEndpoint({
    id: "changeDocumentRelation",
    summary:
      "Установить или снять одно прикрепление по исходной ревизии документа; без повторной записи графа",
    body: "DocumentRelationChange",
    response: "EntitySaved",
  })
  async changeRelation(
    @Body(new ZodValidationPipe(documentRelationChangeSchema)) input: DocumentRelationChange,
  ) {
    return this.changed((library) => library.changeRelation(input, this.workspace.actor()));
  }

  @Post("sections")
  @HttpCode(200)
  @ApiEndpoint({
    id: "changeDocumentSection",
    summary: "Создать, переименовать, переместить или удалить раздел по исходной ревизии проекта",
    body: "DocumentSectionChange",
    response: "EntitySaved",
  })
  async changeSection(
    @Body(new ZodValidationPipe(documentSectionChangeSchema)) input: DocumentSectionChange,
  ) {
    return this.changed((library) => library.changeSection(input, this.workspace.actor()));
  }
}

@Module({ imports: [EventsModule], controllers: [DocumentsController] })
export class DocumentsModule {}
