import { Inject, Injectable } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Observable, Subject } from "rxjs";
import type { ServerEvent } from "@relay/contracts";
import { ProductRepository, PRODUCT_DIRECTORIES } from "@relay/core/storage/product";
import { ProductService } from "@relay/core/application/product/service";
import { BoardRepository } from "@relay/core/storage/boards";
import { BoardTaskRepository } from "@relay/core/storage/board-tasks";
import { BoardTasksService } from "@relay/core/application/board-tasks/service";
import { GraphRepository } from "@relay/core/storage/graph";
import { TaskActivityRepository } from "@relay/core/storage/task-activity";
import { WorkspaceService } from "../workspace/workspace.module.js";
import { ProjectCatalog, ProjectContext } from "../workspace/catalog.js";
import { httpFailure } from "../../common/errors.js";
import { StorageService } from "@relay/core/application/storage/service";

/** Поддерживает SSE активным при простое, до типичных таймаутов прокси. */
const HEARTBEAT_INTERVAL = 15_000;

class ProjectEvents implements OnModuleInit, OnModuleDestroy {
  private readonly events = new Subject<ServerEvent>();
  private readonly watchers = new Map<string, FSWatcher>();
  private lastError: { code: string; message: string } | undefined;
  private storageRoot: string | undefined;
  private productRoot: string | undefined;
  private productPaths: string[] = [];
  private productVersion: string | undefined;
  private boardPaths: string[] = [];
  private boardsVersion: string | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private poll: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private refreshing: Promise<void> | undefined;
  private pending = false;
  private stopped = false;
  private unifiedRoot: string | undefined;
  private readonly changedFiles = new Set<string>();

  constructor(private readonly workspace: ProjectContext) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    // Восстановление после пропущенного fs.watch, удаления или замены каталога.
    this.poll = setInterval(() => void this.refresh(), 3000);
    this.poll.unref();
    this.heartbeat = setInterval(() => {
      this.events.next({ type: "heartbeat", data: { timestamp: new Date().toISOString() } });
    }, HEARTBEAT_INTERVAL);
    this.heartbeat.unref();
  }

  stream(): Observable<ServerEvent> {
    return new Observable((subscriber) => {
      subscriber.next({ type: "connected", data: { projectId: this.workspace.projectId } });
      if (this.lastError) subscriber.next({ type: "workspace-error", data: this.lastError });
      return this.events.subscribe(subscriber);
    });
  }

  apiChanged(): void {
    if (this.stopped) return;
    this.events.next({
      type: "changed",
      data: { source: "api" },
    });
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped || this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.refresh();
    }, 40);
    this.debounce.unref();
  }

  private async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.refreshing) {
      this.pending = true;
      return this.refreshing;
    }
    this.refreshing = this.scan().finally(() => {
      this.refreshing = undefined;
      if (this.pending) {
        this.pending = false;
        this.schedule();
      }
    });
    return this.refreshing;
  }

  private async scan(): Promise<void> {
    try {
      // Наблюдаем и родительские каталоги: atomic rename заменяет inode самого файла.
      this.rebind();
      const workspace = await this.workspace.open();
      if (this.stopped) return;
      this.storageRoot = workspace.root;
      if (await workspace.hasUnifiedStorage()) {
        const root = dirname(workspace.configPath);
        if (this.unifiedRoot !== root) {
          this.watchers.get(root)?.close();
          this.watchers.delete(root);
          this.unifiedRoot = root;
        }
        this.productRoot = undefined;
        this.productPaths = [];
        this.boardPaths = [join(dirname(workspace.configPath), ".indexes")];
        this.rebind();
        const changed = [...this.changedFiles];
        this.changedFiles.clear();
        await new StorageService(workspace).checkExternalChanges(changed);
        const signal = await workspace.locked(async () => workspace.storageSession!.state.version);
        const version = createHash("sha256")
          .update(JSON.stringify([signal, workspace.config]))
          .digest("hex");
        if (this.boardsVersion !== undefined && this.boardsVersion !== version)
          this.events.next({ type: "changed", data: { source: "storage", version } });
        this.boardsVersion = version;
        this.productVersion = undefined;
        if (this.lastError)
          this.events.next({ type: "changed", data: { source: "storage", version } });
        this.lastError = undefined;
        return;
      }
      this.productRoot = new ProductRepository(workspace).root;
      this.rebind();
      const product = await new ProductService(workspace).state();
      this.productPaths = product.records.flatMap((record) =>
        record.fields.kind === "application"
          ? [
              join(this.productRoot!, "applications", record.id),
              join(this.productRoot!, "applications", record.id, "features"),
              join(this.productRoot!, "applications", record.id, "scenarios"),
            ]
          : [],
      );
      const repository = new BoardRepository(workspace);
      const boards = await workspace.locked(() => repository.all());
      this.boardPaths = [
        repository.root,
        new GraphRepository(workspace).root,
        new TaskActivityRepository(workspace).root,
        ...boards.flatMap((board) => [
          join(repository.root, board.slug),
          join(repository.root, board.slug, "tasks"),
        ]),
      ];
      this.rebind();
      const kanban = await workspace.locked(async () => {
        await new BoardTasksService(workspace).list({ limit: 1 });
        return new BoardTaskRepository(workspace).all();
      });
      const relations = await workspace.locked(() => new GraphRepository(workspace).signal());
      const activity = await workspace.locked(() => new TaskActivityRepository(workspace).signal());
      const boardsVersion = createHash("sha256")
        .update(JSON.stringify([workspace.config, boards, kanban, relations, activity]))
        .digest("hex");
      if (this.boardsVersion !== undefined && this.boardsVersion !== boardsVersion)
        this.events.next({ type: "changed", data: { source: "storage" } });
      this.boardsVersion = boardsVersion;
      if (this.productVersion !== undefined && this.productVersion !== product.version)
        this.events.next({ type: "changed", data: { source: "storage" } });
      this.productVersion = product.version;
      if (this.stopped) return;
      if (this.lastError) this.events.next({ type: "changed", data: { source: "storage" } });
      this.lastError = undefined;
    } catch (error) {
      if (this.stopped) return;
      const { code, message } = httpFailure(error).body.error;
      if (this.lastError?.code !== code || this.lastError.message !== message)
        this.events.next({ type: "workspace-error", data: { code, message } });
      this.lastError = { code, message };
    }
  }

  private rebind(): void {
    if (this.stopped) return;
    const configParent = dirname(this.workspace.options.configPath);
    const desired = new Set([
      configParent,
      ...this.boardPaths,
      ...this.productPaths,
      ...(this.productRoot ? [this.productRoot] : []),
      ...(this.productRoot
        ? Object.values(PRODUCT_DIRECTORIES)
            .filter(Boolean)
            .map((directory) => join(this.productRoot!, directory))
        : []),
      ...(this.storageRoot ? [this.storageRoot, dirname(this.storageRoot)] : []),
    ]);
    for (const [path, watcher] of this.watchers) {
      if (!desired.has(path)) {
        watcher.close();
        this.watchers.delete(path);
      }
    }
    for (const path of desired) {
      if (this.watchers.has(path)) continue;
      try {
        const watcher = watch(
          path,
          { persistent: false, recursive: path === this.unifiedRoot },
          (_event, filename) => {
            const name = filename?.toString();
            if (path === this.unifiedRoot && name !== undefined) {
              const relative = name.replaceAll("\\", "/");
              if (
                /^(entities|relations|keyspaces)\/.+\.json$/.test(relative) &&
                !relative.includes("/.indexes/")
              ) {
                this.changedFiles.add(relative);
                this.schedule();
                return;
              }
              if (relative === ".indexes/state.json" || relative === "storage.json")
                this.schedule();
            }
            if (
              name === undefined ||
              this.boardPaths.includes(path) ||
              this.productPaths.includes(path) ||
              (path === configParent && name === "boards") ||
              (path === configParent && (name === ".indexes" || name === "storage.json")) ||
              (path === configParent && name === "task-activity") ||
              (path === configParent && (name === "relations.json" || name === "relations")) ||
              path === this.productRoot ||
              (this.productRoot !== undefined && dirname(path) === this.productRoot) ||
              (path === configParent && name === "product") ||
              (path === configParent && name === basename(this.workspace.options.configPath)) ||
              (path === this.storageRoot && (name.endsWith(".json") || name === basename(path))) ||
              (this.storageRoot &&
                path === dirname(this.storageRoot) &&
                name === basename(this.storageRoot))
            ) {
              // При замене каталога переоткрываем наблюдатель, привязанный к старому inode.
              if (
                this.storageRoot &&
                path === dirname(this.storageRoot) &&
                name === basename(this.storageRoot)
              ) {
                this.watchers.get(this.storageRoot)?.close();
                this.watchers.delete(this.storageRoot);
              }
              this.schedule();
            }
          },
        );
        watcher.on("error", () => {
          watcher.close();
          if (this.watchers.get(path) === watcher) this.watchers.delete(path);
          this.schedule();
        });
        this.watchers.set(path, watcher);
      } catch {
        // Каталог может временно отсутствовать. Poll повторит подписку и проверку Core.
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.debounce);
    clearInterval(this.poll);
    clearInterval(this.heartbeat);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.events.complete();
    await this.refreshing;
  }
}

/** Один наблюдатель на проект; реестр и потоки разных баз имеют независимый lifecycle. */
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly projects = new Map<
    string,
    { context: ProjectContext; events: ProjectEvents; ready: Promise<void> }
  >();
  private poll: NodeJS.Timeout | undefined;
  private stopped = false;
  private syncing: Promise<void> | undefined;

  constructor(@Inject(ProjectCatalog) private readonly catalog: ProjectCatalog) {}

  private async acquire(context: ProjectContext) {
    const key = context.options.configPath;
    let item = this.projects.get(key);
    if (!item) {
      const events = new ProjectEvents(context);
      item = { context, events, ready: events.onModuleInit() };
      this.projects.set(key, item);
    }
    await item.ready;
    return item.events;
  }

  private async sync() {
    const { projects } = await this.catalog.context();
    if (this.stopped) return;
    const paths = new Set(projects.map((project) => project.configPath));
    for (const [path, item] of this.projects) {
      if (!paths.has(path)) {
        this.projects.delete(path);
        await item.ready;
        await item.events.onModuleDestroy();
      }
    }
    for (const project of projects) {
      if (this.stopped) return;
      if (project.available) await this.acquire(await this.catalog.at(project.configPath));
    }
  }

  async onModuleInit() {
    await this.sync();
    this.poll = setInterval(() => {
      if (this.syncing || this.stopped) return;
      this.syncing = this.sync()
        .catch(() => {})
        .finally(() => {
          this.syncing = undefined;
        });
    }, 1000);
    this.poll.unref();
  }

  async stream(workspace: WorkspaceService) {
    return (await this.acquire(await workspace.resolve())).stream();
  }

  async apiChanged(project: string | undefined) {
    if (!this.stopped) (await this.acquire(await this.catalog.select(project))).apiChanged();
  }

  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.poll);
    await this.syncing;
    await Promise.all(
      [...this.projects.values()].map(async (item) => {
        await item.ready;
        await item.events.onModuleDestroy();
      }),
    );
    this.projects.clear();
  }
}
