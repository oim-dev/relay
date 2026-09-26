import { Body, Controller, Get, HttpCode, Inject, Module, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { success } from "@relay/contracts";
import { ProductQueries } from "@relay/core/application/product/queries";
import {
  productContextQuerySchema,
  productListQuerySchema,
  productMutationSchema,
} from "@relay/core/domain/product";
import type {
  ProductContextQuery,
  ProductListQuery,
  ProductMutation,
} from "@relay/core/domain/product";
import { ApiEndpoint } from "../../openapi/endpoint.js";
import { ZodValidationPipe } from "../../common/validation.js";
import { WorkspaceService } from "../workspace/workspace.module.js";
import { EventsService } from "../events/events.service.js";
import { EventsModule } from "../events/events.module.js";
import {
  productEntitiesQuerySchema,
  productEntityQuerySchema,
  updateImplementationSchema,
} from "@relay/core/domain/product-implementation";
import type {
  ProductEntitiesQuery,
  UpdateImplementation,
} from "@relay/core/domain/product-implementation";

@ApiTags("product")
@Controller("product")
class ProductController {
  constructor(
    @Inject(WorkspaceService) private readonly workspace: WorkspaceService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  @Get("entities")
  @ApiEndpoint({
    id: "getProductEntities",
    summary: "Найти продуктовые цели без загрузки Markdown; до 100 записей и продолжение",
    response: "ProductEntities",
    query: "ProductEntitiesQuery",
  })
  async entities(@Query() query: ProductEntitiesQuery) {
    const normalized = {
      ...query,
      ...(typeof query.refs === "string" ? { refs: [query.refs] } : {}),
    };
    const parsed = new ZodValidationPipe(productEntitiesQuerySchema).transform(normalized);
    return success(await new ProductQueries(await this.workspace.open()).entities(parsed));
  }

  @Get("entity")
  @ApiEndpoint({
    id: "getProductEntity",
    summary: "Прочитать фичу, сценарий, приложение или реализацию по ключу либо ID",
    response: "ProductEntity",
    query: "ProductEntityQuery",
  })
  async entity(@Query(new ZodValidationPipe(productEntityQuerySchema)) query: { ref: string }) {
    return success(await new ProductQueries(await this.workspace.open()).entity(query.ref));
  }

  @Post("implementations")
  @HttpCode(200)
  @ApiEndpoint({
    id: "updateProductImplementation",
    summary: "Изменить отдельную реализацию с проверкой её ревизии",
    response: "ProductSaved",
    body: "UpdateImplementation",
  })
  async implementation(
    @Body(new ZodValidationPipe(updateImplementationSchema)) input: UpdateImplementation,
  ) {
    const workspace = await this.workspace.open();
    const result = await new ProductQueries(workspace).updateImplementation(
      input,
      this.workspace.actor(),
    );
    await this.events.apiChanged(workspace.config.projectId).catch(() => {});
    return success(result);
  }

  @Get("state")
  @ApiEndpoint({
    id: "getProductState",
    summary: "Согласованное состояние продукта и готовность",
    response: "ProductState",
  })
  async state() {
    return success(await new ProductQueries(await this.workspace.open()).state());
  }

  @Get("overview")
  @ApiEndpoint({
    id: "getProductOverview",
    summary: "Компактная карта продукта без полных текстов",
    response: "ProductOverview",
  })
  async overview() {
    return success(await new ProductQueries(await this.workspace.open()).overview());
  }

  @Get("records")
  @ApiEndpoint({
    id: "getProductRecords",
    summary: "Поиск и чтение записей продукта",
    response: "ProductList",
    query: "ProductListQuery",
  })
  async list(@Query(new ZodValidationPipe(productListQuerySchema)) query: ProductListQuery) {
    return success(await new ProductQueries(await this.workspace.open()).list(query));
  }

  @Get("context")
  @ApiEndpoint({
    id: "getProductContext",
    summary: "Связанный продуктовый контекст",
    response: "ProductContext",
    query: "ProductContextQuery",
  })
  async context(
    @Query(new ZodValidationPipe(productContextQuerySchema)) query: ProductContextQuery,
  ) {
    return success(await new ProductQueries(await this.workspace.open()).context(query));
  }

  @Post("records")
  @HttpCode(200)
  @ApiEndpoint({
    id: "mutateProduct",
    summary: "Создать или изменить запись продукта",
    response: "ProductSaved",
    body: "ProductMutation",
  })
  async mutate(@Body(new ZodValidationPipe(productMutationSchema)) input: ProductMutation) {
    const workspace = await this.workspace.open();
    const result = await new ProductQueries(workspace).mutate(input, this.workspace.actor());
    await this.events.apiChanged(workspace.config.projectId).catch(() => {});
    return success(result);
  }
}

@Module({ imports: [EventsModule], controllers: [ProductController] })
export class ProductModule {}
