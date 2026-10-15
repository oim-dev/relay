import { Module } from "@nestjs/common";
import type { DynamicModule } from "@nestjs/common";
import { ServeStaticModule } from "@nestjs/serve-static";
import { HealthModule } from "./modules/health/health.module.js";
import { ContextModule } from "./modules/context/context.module.js";
import { EventsModule } from "./modules/events/events.module.js";
import { WorkspaceModule } from "./modules/workspace/workspace.module.js";
import type { WorkspaceOptions } from "./modules/workspace/workspace.module.js";
import { ProjectModule } from "./modules/project/project.module.js";
import { ServerModule } from "./modules/workspace/server.module.js";
import { ProductModule } from "./modules/product/product.module.js";
import { ProgressModule } from "./modules/progress/progress.module.js";
import { BoardsModule } from "./modules/boards/boards.module.js";
import { BoardTasksModule } from "./modules/board-tasks/board-tasks.module.js";
import { GraphModule } from "./modules/graph/graph.module.js";
import { EntitiesModule } from "./modules/entities/entities.module.js";
import { DocumentsModule } from "./modules/documents/documents.module.js";
import { PlanningModule } from "./modules/planning/planning.module.js";
import { ReleasesModule } from "./modules/releases/releases.module.js";
import { WorkHistoryModule } from "./modules/work-history/work-history.module.js";

@Module({})
export class AppModule {
  static register(workspace: WorkspaceOptions, webRoot?: string): DynamicModule {
    const staticOptions = {
      fallthrough: true,
      dotfiles: "deny",
      redirect: false,
      cacheControl: false,
      // Fastify-опция: статические файлы не могут занять зарезервированный /api.
      globIgnore: ["api/**"],
    };
    return {
      module: AppModule,
      imports: [
        WorkspaceModule.register(workspace),
        HealthModule,
        ServerModule,
        ContextModule,
        ProjectModule,
        ProductModule,
        ProgressModule,
        PlanningModule,
        ReleasesModule,
        WorkHistoryModule,
        BoardsModule,
        BoardTasksModule,
        GraphModule,
        EntitiesModule,
        DocumentsModule,
        EventsModule,
        ...(webRoot
          ? [
              ServeStaticModule.forRoot({
                rootPath: webRoot,
                renderPath: "/*",
                serveStaticOptions: staticOptions,
              }),
            ]
          : []),
      ],
    };
  }
}
