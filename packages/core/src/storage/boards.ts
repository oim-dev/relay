import { mkdir, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { boardSchema, defaultBoardPrefix } from "../domain/board.js";
import { derivedId, shortId } from "../shared/ids.js";
import type { Board } from "../domain/board.js";
import { productRecordSchema } from "../domain/product.js";
import type { ProductRecord } from "../domain/product.js";
import { parse } from "../domain/validation.js";
import { invariant, isErrno } from "../shared/errors.js";
import { atomicJson, exists, jsonFiles, readJson, syncDirectory } from "./files.js";
import { ProductRepository } from "./product.js";
import { encodeProduct, decodeProduct } from "./product-codec.js";
import type { Workspace } from "./workspace.js";
import * as unified from "./unified-adapter.js";

/** Контейнеры досок и долговечные намерения создания приложения с доской. */
export class BoardRepository {
  readonly root: string;
  readonly pending: string;
  constructor(readonly workspace: Workspace) {
    this.root = join(dirname(workspace.configPath), "boards");
    this.pending = join(this.root, ".pending-applications");
  }

  async all(): Promise<Board[]> {
    if (!this.workspace.storageSession && (await this.workspace.hasUnifiedStorage()))
      return this.workspace.locked(() => this.all());
    if (this.workspace.storageSession) return unified.boards(this.workspace);
    const entries = await readdir(this.root, { withFileTypes: true }).catch((error: unknown) => {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    });
    const boards: Board[] = [];
    for (const entry of entries) {
      if (entry.name === ".pending-applications") continue;
      invariant(
        entry.isDirectory(),
        "INVALID_DATA",
        `Некорректный каталог доски: ${entry.name}`,
        5,
      );
      const path = join(this.root, entry.name, "board.json");
      const board = parse(boardSchema, await readJson(path), path, true);
      invariant(
        board.slug === entry.name,
        "INVALID_DATA",
        "Slug доски не совпадает с каталогом",
        5,
      );
      invariant(
        !boards.some((other) => other.id === board.id),
        "INVALID_DATA",
        "Дублирующийся ID доски",
        5,
      );
      boards.push(board);
    }
    return boards.sort((left, right) => left.id.localeCompare(right.id));
  }

  /** Повтор восстанавливает только недостающие части, никогда не переписывая задачи. */
  async ensure(board: Board, assertOwned: () => void): Promise<void> {
    parse(boardSchema, board, "доска");
    if (this.workspace.storageSession) {
      const existing = await this.all();
      const prior = existing.find((entry) => entry.id === board.id || entry.slug === board.slug);
      if (prior) {
        invariant(
          prior.id === board.id &&
            prior.slug === board.slug &&
            prior.kind === board.kind &&
            prior.applicationId === board.applicationId,
          "ALREADY_EXISTS",
          "Адрес доски уже занят",
          4,
        );
        return;
      }
      invariant(
        !existing.some(
          (entry) => entry.prefix === (board.prefix ?? defaultBoardPrefix(board.slug)),
        ),
        "ALREADY_EXISTS",
        "Префикс доски уже занят",
        4,
      );
      await unified.saveBoard(this.workspace, board);
      return;
    }
    const others = (await this.all()).filter((entry) => entry.slug !== board.slug);
    invariant(
      !others.some((entry) => entry.id === board.id),
      "ALREADY_EXISTS",
      "ID доски уже занят",
      4,
    );
    invariant(
      !others.some(
        (entry) =>
          (entry.prefix ?? defaultBoardPrefix(entry.slug)) ===
          (board.prefix ?? defaultBoardPrefix(board.slug)),
      ),
      "ALREADY_EXISTS",
      "Префикс доски уже занят",
      4,
    );
    assertOwned();
    const directory = join(this.root, board.slug);
    const path = join(directory, "board.json");
    if (await exists(path)) {
      const previous = parse(boardSchema, await readJson(path), path, true);
      invariant(
        previous.id === board.id &&
          previous.slug === board.slug &&
          previous.kind === board.kind &&
          previous.applicationId === board.applicationId,
        "ALREADY_EXISTS",
        "Адрес доски уже занят",
        4,
      );
    } else {
      await mkdir(directory, { recursive: true });
      await atomicJson(path, board, this.workspace.runtime, true, assertOwned);
    }
    await mkdir(join(directory, "tasks"), { recursive: true });
    await syncDirectory(directory);
  }

  async initialize(assertOwned: () => void): Promise<void> {
    const existing = await this.all();
    await this.ensure(
      {
        version: 1,
        id:
          existing.find((board) => board.kind === "product")?.id ??
          shortId(existing.map((board) => board.id)),
        slug: "product",
        prefix: defaultBoardPrefix("product"),
        kind: "product",
        applicationId: null,
        revision: 1,
        createdAt: new Date().toISOString(),
        createdBy: "relay",
      },
      assertOwned,
    );
  }

  /** До публикации двух файлов фиксируется возобновляемое намерение вне временного runtime. */
  async createApplication(record: ProductRecord, assertOwned: () => void): Promise<void> {
    invariant(record.fields.kind === "application", "INVALID_ARGUMENT", "Ожидается приложение");
    if (this.workspace.storageSession) {
      await unified.saveProduct(this.workspace, record);
      await this.ensure(
        {
          version: 1,
          id: record.id.startsWith("application_")
            ? record.id.replace("application_", "board_")
            : derivedId(`board:${record.id}`),
          slug: record.fields.slug,
          prefix: record.fields.prefix ?? defaultBoardPrefix(record.fields.slug),
          kind: "application",
          applicationId: record.id,
          revision: 1,
          createdAt: record.createdAt,
          createdBy: record.createdBy,
        },
        assertOwned,
      );
      return;
    }
    await mkdir(this.pending, { recursive: true });
    await atomicJson(
      join(this.pending, `${record.id}.json`),
      encodeProduct(record),
      this.workspace.runtime,
      true,
      assertOwned,
    );
    await this.recover(assertOwned);
  }

  /** Вызывается под общей блокировкой перед любым чтением или изменением проекта. */
  async recover(assertOwned: () => void): Promise<void> {
    for (const filename of await jsonFiles(this.pending)) {
      const path = join(this.pending, filename);
      const record = decodeProduct(await readJson(path, 16 * 1024 * 1024), path);
      invariant(
        record.fields.kind === "application" && `${record.id}.json` === filename,
        "INVALID_DATA",
        "Некорректное намерение создания доски",
        5,
      );
      const products = new ProductRepository(this.workspace);
      invariant(
        record.productId === products.productId,
        "INVALID_DATA",
        "Чужой проект в намерении",
        5,
      );
      const previous = (await products.all()).find((entry) => entry.id === record.id);
      if (previous)
        invariant(
          JSON.stringify(productRecordSchema.parse(previous)) === JSON.stringify(record),
          "INVALID_DATA",
          "Приложение изменилось во время восстановления доски",
          5,
        );
      await this.ensure(
        {
          version: 1,
          id: record.id.startsWith("application_")
            ? record.id.replace("application_", "board_")
            : derivedId(`board:${record.id}`),
          slug: record.fields.slug,
          prefix: record.fields.prefix ?? defaultBoardPrefix(record.fields.slug),
          kind: "application",
          applicationId: record.id,
          revision: 1,
          createdAt: record.createdAt,
          createdBy: record.createdBy,
        },
        assertOwned,
      );
      if (!previous) await products.save(record, true, assertOwned);
      assertOwned();
      await unlink(path);
      await syncDirectory(this.pending);
    }
  }
}
