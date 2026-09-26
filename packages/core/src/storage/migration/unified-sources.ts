import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { actorSchema, requestIdSchema } from "@relay/contracts/primitives";
import { entityRefSchema } from "@relay/contracts/entities/graph";
import { AppError, invariant, isErrno } from "../../shared/errors.js";
import { readJson } from "../files.js";
import {
  digest,
  hashSchema,
  keyHash,
  RECORD_BYTES,
  relativePathSchema,
  stateSchema,
} from "../entity-store/format.js";

/** Проверяет, что внешняя блокировка всё ещё принадлежит вызывающему. */
export type MigrationOwned = () => void;

// Замороженные декодеры прежнего диска: не зависят от рабочего журнала и его DTO.
const manifestSchema = z.strictObject({
  format: z.literal("relay-entities"),
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  productId: z.string().optional(),
});
const indexedSchema = z.strictObject({
  kind: z.literal("indexed"),
  index: z.string(),
  key: z.string(),
  value: z.json(),
  groups: z.array(
    z.strictObject({
      index: z.string(),
      key: z.string(),
      member: z.string().nullable().default(null),
    }),
  ),
});
const entrySchema = z.strictObject({
  at: z.iso.datetime(),
  actor: actorSchema,
  namespace: z.string(),
  requestId: requestIdSchema,
  requestHash: z.string(),
  result: z.json(),
  refs: z.array(entityRefSchema),
  events: z.array(z.json()),
});
const operationSchema = entrySchema.extend({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  changes: z.array(
    z.strictObject({
      path: relativePathSchema,
      before: z.json().nullable(),
      after: z.json().nullable(),
    }),
  ),
});
const segmentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  first: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  entries: z.array(entrySchema).min(1).max(128),
});
const indexSegmentSchema = z.discriminatedUnion("type", [
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("leaf"),
    entries: z
      .array(z.tuple([z.string(), z.json()]))
      .min(1)
      .max(1024),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("branch"),
    children: z.record(z.string().regex(/^[a-f0-9]$/), hashSchema),
  }),
]);

export type UnifiedMigrationIndexedEvent = z.output<typeof indexedSchema>;
export type UnifiedMigrationOperation = z.output<typeof entrySchema> & {
  id: string;
  schemaVersion: 1 | 2;
  sourcePath: string;
  indexed: UnifiedMigrationIndexedEvent[];
  changes?: z.output<typeof operationSchema>["changes"];
};
export type UnifiedMigrationSources = {
  version: 1 | 2;
  operations: UnifiedMigrationOperation[];
  segments: Array<{ path: string; segment: z.output<typeof segmentSchema> }>;
  /** Все прочитанные файлы, включая маркер и индекс; НЕ список удаления. */
  files: Array<{ path: string; hash: string }>;
  /** Только проверенные операции/сегменты. Неизвестные файлы сюда не включаются. */
  sourceFiles: Array<{ path: string; hash: string }>;
};

const operationPath = /^operations\/([a-f0-9-]{36})\.json$/;
const historyPath = /^history\/([a-f0-9-]{36})\/([0-9]{16})\.json$/;

/** Только чтение после recovery под внешней блокировкой; результат живёт в памяти мигратора. */
export async function readUnifiedMigrationSources(
  root: string,
  owned: MigrationOwned,
): Promise<UnifiedMigrationSources> {
  const files = new Map<string, string>();
  const safePath = async (path: string) => {
    relativePathSchema.parse(path);
    let current = root;
    for (const part of path.split("/")) {
      current = join(current, part);
      invariant(
        !(await lstat(current)).isSymbolicLink(),
        "INVALID_DATA",
        "Источник миграции не может быть символической ссылкой",
        5,
        { path },
      );
    }
  };
  const read = async (path: string) => {
    owned();
    try {
      await safePath(path);
      const raw = z.json().parse(await readJson(join(root, path), RECORD_BYTES));
      files.set(path, digest(raw));
      owned();
      return raw;
    } catch (error) {
      if (isErrno(error, "ENOENT") || (error instanceof AppError && error.code === "NOT_FOUND"))
        throw new AppError("STORAGE_INDEX_CORRUPT", "Ожидаемый источник миграции отсутствует", 5, {
          path,
        });
      throw error;
    }
  };
  const manifest = manifestSchema.parse(await read("storage.json"));
  const state = stateSchema.parse(await read(".indexes/state.json"));
  const expected = new Map<string, string>();
  const seenKeys = new Set<string>();
  const scanIndex = async (hash: string, prefix: string): Promise<void> => {
    invariant(
      prefix.length <= 64,
      "STORAGE_INDEX_CORRUPT",
      "Слишком глубокий индекс источников",
      5,
    );
    const path = `.indexes/segments/${hash.slice(0, 2)}/${hash}.json`;
    const raw = await read(path);
    invariant(digest(raw) === hash, "STORAGE_INDEX_CORRUPT", "Повреждён индекс источников", 5, {
      path,
    });
    const segment = indexSegmentSchema.parse(raw);
    if (segment.type === "branch") {
      for (const [nibble, child] of Object.entries(segment.children))
        await scanIndex(child, prefix + nibble);
    } else
      for (const [key, value] of segment.entries) {
        invariant(
          !seenKeys.has(key) && keyHash(key).startsWith(prefix),
          "STORAGE_INDEX_CORRUPT",
          "Неверный адрес или повтор ключа индекса",
          5,
        );
        seenKeys.add(key);
        if (key.startsWith("operations/") || key.startsWith("history/")) {
          const match =
            manifest.schemaVersion === 1 ? operationPath.exec(key) : historyPath.exec(key);
          invariant(
            match && z.uuid().safeParse(match[1]).success,
            "STORAGE_INDEX_CORRUPT",
            "Неожиданный путь источника для версии базы",
            5,
            { path: key },
          );
          expected.set(key, hashSchema.parse(value));
        }
      }
  };
  const indexRoot = state.roots["file-hashes"];
  invariant(
    indexRoot !== undefined,
    "STORAGE_INDEX_CORRUPT",
    "Отсутствует индекс ожидаемых файлов",
    5,
  );
  if (indexRoot !== null) await scanIndex(indexRoot, "");

  // Неиндексированный файл с корректным служебным именем нельзя молча потерять.
  // Посторонние имена не читаются и никогда не становятся кандидатами удаления.
  const list = async (path: string): Promise<string[]> => {
    owned();
    try {
      await safePath(path);
      return (await readdir(join(root, path))).sort();
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
  };
  const discovered = (path: string) => {
    invariant(
      expected.has(path),
      "STORAGE_INDEX_STALE",
      "Обнаружен неиндексированный источник; выполните reindex",
      4,
      { path },
    );
  };
  for (const name of await list("operations")) {
    const path = `operations/${name}`;
    if (operationPath.test(path)) discovered(path);
  }
  for (const stream of await list("history"))
    if (z.uuid().safeParse(stream).success) {
      for (const name of await list(`history/${stream}`)) {
        const path = `history/${stream}/${name}`;
        if (historyPath.test(path)) discovered(path);
      }
    }

  const operations: UnifiedMigrationOperation[] = [];
  const segments: UnifiedMigrationSources["segments"] = [];
  const sourceFiles: UnifiedMigrationSources["sourceFiles"] = [];
  const ends = new Map<string, number>();
  const add = (
    entry: z.output<typeof entrySchema>,
    id: string,
    path: string,
    version: 1 | 2,
    changes?: UnifiedMigrationOperation["changes"],
  ) => {
    const indexed = entry.events.flatMap((event) => {
      if (
        version === 1 &&
        (event === null ||
          typeof event !== "object" ||
          Array.isArray(event) ||
          event.kind !== "indexed")
      )
        return [];
      return [indexedSchema.parse(event)];
    });
    operations.push({
      ...entry,
      id,
      schemaVersion: version,
      sourcePath: path,
      indexed,
      ...(changes === undefined ? {} : { changes }),
    });
  };
  for (const [path, hash] of [...expected].sort(([a], [b]) => a.localeCompare(b))) {
    const raw = await read(path);
    invariant(
      digest(raw) === hash,
      "STORAGE_INDEX_STALE",
      "Источник изменён вне Core; выполните reindex",
      4,
      { path },
    );
    if (manifest.schemaVersion === 1) {
      const operation = operationSchema.parse(raw);
      invariant(
        path === `operations/${operation.id}.json`,
        "INVALID_DATA",
        "ID операции не совпадает с путём",
        5,
        { path },
      );
      add(operation, operation.id, path, 1, operation.changes);
    } else {
      const segment = segmentSchema.parse(raw);
      const match = historyPath.exec(path)!;
      const stream = match[1]!;
      const end = segment.first + (segment.entries.length - 1);
      invariant(
        Number(match[2]) === segment.first && Number.isSafeInteger(end),
        "INVALID_DATA",
        "Неверный номер или диапазон сегмента",
        5,
        { path },
      );
      invariant(
        segment.first > (ends.get(stream) ?? 0),
        "STORAGE_INDEX_CONFLICT",
        "Пересекаются диапазоны сегментов истории",
        4,
        { path },
      );
      ends.set(stream, end);
      segments.push({ path, segment });
      segment.entries.forEach((entry, offset) =>
        add(entry, `${stream}:${segment.first + offset}`, path, 2),
      );
    }
    sourceFiles.push({ path, hash });
  }
  owned();
  return {
    version: manifest.schemaVersion,
    operations,
    segments,
    sourceFiles,
    files: [...files].map(([path, hash]) => ({ path, hash })),
  };
}
