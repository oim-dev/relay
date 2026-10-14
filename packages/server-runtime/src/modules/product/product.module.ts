import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiParam, ApiTags } from "@nestjs/swagger";
import { success } from "@relay/contracts";
import { ProductQueries } from "@relay/core/application/product/queries";
import {
  productLintQuerySchema,
  productOverviewMapQuerySchema,
  type ProductLintQuery,
  type ProductOverviewMapQuery,
} from "@relay/contracts/product-query";
import {
  productParticipationQuerySchema,
  productParticipationReplaceSchema,
  type ProductParticipationQuery,
  type ProductParticipationReplace,
} from "@relay/contracts/product-participation";
import {
  productContextQuerySchema,
  productListQuerySchema,
  productMutationSchema,
  productOverviewMetrics,
} from "@relay/core/domain/product";
import type {
  ProductContextQuery,
  ProductListQuery,
  ProductMutation,
  ProductOverviewMetricQuery,
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

  @Get("validate")
  @ApiEndpoint({
    id: "validateProduct",
    summary: "Проверить структурные инварианты продукта без передачи его текстов",
    response: "ProductValidation",
  })
  async validate() {
    return success(await new ProductQueries(await this.workspace.open()).validate());
  }

  @Get("lint")
  @ApiEndpoint({
    id: "lintProduct",
    summary: "Страница адресуемых рекомендаций по содержанию продукта, включая FI/SI",
    query: "ProductLintQuery",
    response: "ProductLintPage",
  })
  async lint(@Query(new ZodValidationPipe(productLintQuerySchema)) query: ProductLintQuery) {
    return success(await new ProductQueries(await this.workspace.open()).lint(query));
  }

  @Get("overview/map")
  @ApiEndpoint({
    id: "getProductOverviewMap",
    summary: "Страница карты на snapshotVersion обзора без повторения общего среза",
    query: "ProductOverviewMapQuery",
    response: "ProductOverviewMapPage",
  })
  async overviewMap(
    @Query(new ZodValidationPipe(productOverviewMapQuerySchema)) query: ProductOverviewMapQuery,
  ) {
    return success(await new ProductQueries(await this.workspace.open()).overviewMap(query));
  }

  @Get("participation")
  @ApiEndpoint({
    id: "getProductParticipation",
    summary: "Страница активных и снятых FI/SI приложения с guards замены состава",
    query: "ProductParticipationQuery",
    response: "ProductParticipationPage",
  })
  async participation(
    @Query(new ZodValidationPipe(productParticipationQuerySchema)) query: ProductParticipationQuery,
  ) {
    return success(await new ProductQueries(await this.workspace.open()).participation(query));
  }

  @Post("participation")
  @HttpCode(200)
  @ApiEndpoint({
    id: "replaceProductParticipation",
    summary:
      "Атомарно заменить состав existing/new targets без перезаписи текстов существующих FI/SI",
    body: "ProductParticipationReplace",
    response: "ProductParticipationSaved",
  })
  async replaceParticipation(
    @Body(new ZodValidationPipe(productParticipationReplaceSchema))
    input: ProductParticipationReplace,
  ) {
    const workspace = await this.workspace.open();
    const result = await new ProductQueries(workspace).replaceParticipation(
      input,
      this.workspace.actor(),
    );
    await this.events.apiChanged(workspace.config.projectId).catch(() => {});
    return success(result);
  }

  @Get("implementation")
  @ApiEndpoint({
    id: "getProductImplementation",
    summary: "Полная реализация: Markdown и сохранённый status отдельно от вычисленной готовности",
    query: "ProductEntityQuery",
    response: "ProductImplementationDetail",
  })
  async implementationDetail(
    @Query(new ZodValidationPipe(productEntityQuerySchema)) query: { ref: string },
  ) {
    return success(await new ProductQueries(await this.workspace.open()).implementation(query.ref));
  }

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

  @Get("overview/metrics/:metric")
  @ApiParam({
    name: "metric",
    enum: productOverviewMetrics,
    enumName: "ProductOverviewMetric",
    description:
      "Раскрываемая метрика оператора обзора; неизвестное значение — UNKNOWN_METRIC (400)",
  })
  @ApiEndpoint({
    id: "getProductOverviewMetric",
    summary:
      "Страница полной выборки метрики оператора обзора (snapshot.operator) с продолжением на неизменном срезе",
    response: "ProductOverviewMetricPage",
    query: "ProductOverviewMetricPageQuery",
  })
  async overviewMetric(@Param("metric") metric: string, @Query() query: Record<string, unknown>) {
    // Метрику, блокер и страницу проверяет Core: транспорт не дублирует предметные правила.
    return success(
      await new ProductQueries(await this.workspace.open()).overviewMetric({
        ...query,
        metric,
      } as ProductOverviewMetricQuery),
    );
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
