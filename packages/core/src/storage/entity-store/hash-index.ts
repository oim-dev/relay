import { join } from "node:path";
import { z } from "zod";
import type { JsonValue } from "@relay/contracts/storage";
import { readJson } from "../files.js";
import { AppError, invariant } from "../../shared/errors.js";
import { digest, hashSchema, keyHash, canonical } from "./format.js";
import type { FileChange } from "./format.js";

const LEAF_ENTRIES = 1024;
const SEGMENT_BYTES = 1024 * 1024;
const CACHE_BYTES = 64 * 1024 * 1024;
const CACHE_ENTRIES = 4096;
/** Строгая схема страницы индекса; её же применяет явная диагностика обслуживания. */
export const indexSegmentSchema = z.discriminatedUnion("type", [
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("leaf"),
    entries: z
      .array(z.tuple([z.string(), z.json()]))
      .min(1)
      .max(LEAF_ENTRIES),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("branch"),
    children: z.record(z.string().regex(/^[a-f0-9]$/), hashSchema),
  }),
]);
const segmentSchema = indexSegmentSchema;
type Segment = z.infer<typeof segmentSchema>;
type CacheEntry = { segment: Segment; bytes: number };
// Один ограниченный кеш на процесс; реальный путь базы включён в ключ, projectId не используется.
const cache = new Map<string, CacheEntry>();
const loading = new Map<string, Promise<Segment>>();
let cacheBytes = 0;
const leafPrefixes = new WeakMap<Segment, string>();
const leafEntries = new WeakMap<Segment, ReadonlyMap<string, JsonValue>>();
const segmentPath = (hash: string) => `.indexes/segments/${hash.slice(0, 2)}/${hash}.json`;

function leafPrefix(segment: Extract<Segment, { type: "leaf" }>): string {
  const cached = leafPrefixes.get(segment);
  if (cached !== undefined) return cached;
  let prefix = keyHash(segment.entries[0]![0]);
  for (const [key] of segment.entries.slice(1)) {
    const hash = keyHash(key);
    let length = 0;
    while (length < prefix.length && prefix[length] === hash[length]) length++;
    prefix = prefix.slice(0, length);
    if (!prefix) break;
  }
  leafPrefixes.set(segment, prefix);
  return prefix;
}

function remember(key: string, segment: Segment) {
  const bytes = Buffer.byteLength(JSON.stringify(segment));
  const previous = cache.get(key);
  if (previous) cacheBytes -= previous.bytes;
  cache.delete(key);
  cache.set(key, { segment, bytes });
  cacheBytes += bytes;
  while (cacheBytes > CACHE_BYTES || cache.size > CACHE_ENTRIES) {
    const first = cache.keys().next().value!;
    cacheBytes -= cache.get(first)!.bytes;
    cache.delete(first);
  }
}

/** Для явной проверки/перестроения; обычное чтение переиспользует неизменяемые сегменты. */
export function forgetStorageSegments(root: string) {
  for (const [key, entry] of cache)
    if (key.startsWith(`${root}\0`)) {
      cacheBytes -= entry.bytes;
      cache.delete(key);
    }
}

/** Неизменяемое JSON-дерево. Пакет меняет только ветви затронутых точных адресов. */
export class HashIndex {
  readonly metrics = { segmentReads: 0 };
  private readonly prepared = new Map<string, Segment>();
  constructor(readonly root: string) {}

  private async segment(hash: string): Promise<Segment> {
    hashSchema.parse(hash);
    const pending = this.prepared.get(hash);
    if (pending) return pending;
    const key = `${this.root}\0${hash}`;
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return cached.segment;
    }
    let promise = loading.get(key);
    if (!promise) {
      promise = (async () => {
        try {
          this.metrics.segmentReads++;
          const raw = await readJson(join(this.root, segmentPath(hash)), SEGMENT_BYTES);
          const segment = segmentSchema.parse(raw);
          invariant(
            digest(segment) === hash,
            "STORAGE_INDEX_CORRUPT",
            "Контрольная сумма сегмента не совпадает",
            5,
          );
          if (segment.type === "leaf") {
            const keys = segment.entries.map(([entry]) => entry);
            invariant(
              new Set(keys).size === keys.length,
              "STORAGE_INDEX_CORRUPT",
              "Повтор ключа внутри сегмента",
              5,
            );
          }
          remember(key, segment);
          return segment;
        } catch (error) {
          if (error instanceof AppError && error.code === "STORAGE_INDEX_CORRUPT") throw error;
          throw new AppError(
            "STORAGE_INDEX_CORRUPT",
            "Ожидаемый сегмент индекса отсутствует или повреждён. Выполните перестроение",
            5,
            { hash, cause: error instanceof Error ? error.message : String(error) },
          );
        }
      })();
      loading.set(key, promise);
    }
    try {
      return await promise;
    } finally {
      if (loading.get(key) === promise) loading.delete(key);
    }
  }

  async get(root: string | null, key: string): Promise<JsonValue | undefined> {
    const value = await this.lookup(root, key);
    return value === undefined ? undefined : structuredClone(value);
  }

  /** Схема Zod создаёт проверенное представление без предварительного глубокого копирования. */
  async getParsed<T>(
    root: string | null,
    key: string,
    schema: z.ZodType<T>,
  ): Promise<T | undefined> {
    const value = await this.lookup(root, key);
    return value === undefined ? undefined : schema.parse(value);
  }

  private async lookup(root: string | null, key: string): Promise<JsonValue | undefined> {
    const hash = keyHash(key);
    let pointer = root;
    let depth = 0;
    while (pointer) {
      invariant(depth <= 64, "STORAGE_INDEX_CORRUPT", "Слишком глубокий индекс", 5);
      const segment = await this.segment(pointer);
      if (segment.type === "leaf") {
        const prefix = leafPrefix(segment);
        invariant(
          prefix.length >= depth && prefix.slice(0, depth) === hash.slice(0, depth),
          "STORAGE_INDEX_CORRUPT",
          "Запись находится в чужой ветви индекса",
          5,
        );
        let entries = leafEntries.get(segment);
        if (!entries) {
          entries = new Map(segment.entries);
          leafEntries.set(segment, entries);
        }
        return entries.get(key);
      }
      pointer = segment.children[hash[depth++]!] ?? null;
    }
    return undefined;
  }

  /** Полный обход применяется для списков и обслуживания, не для разрешения одного ключа. */
  async entries(root: string | null): Promise<[string, JsonValue][]> {
    const output: [string, JsonValue][] = [];
    const pending = root ? [{ hash: root, prefix: "" }] : [];
    while (pending.length) {
      const { hash, prefix } = pending.pop()!;
      invariant(prefix.length <= 64, "STORAGE_INDEX_CORRUPT", "Слишком глубокий индекс", 5);
      const segment = await this.segment(hash);
      if (segment.type === "branch") {
        for (const [nibble, child] of Object.entries(segment.children))
          pending.push({ hash: child, prefix: prefix + nibble });
      } else
        for (const [key, value] of segment.entries) {
          invariant(
            keyHash(key).startsWith(prefix),
            "STORAGE_INDEX_CORRUPT",
            "Запись находится в чужой ветви индекса",
            5,
          );
          output.push([key, structuredClone(value)]);
        }
    }
    return output.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  async update(
    root: string | null,
    changes: ReadonlyMap<string, JsonValue | undefined>,
  ): Promise<string | null> {
    return this.change(root, [...changes], 0);
  }

  /** Живые сегменты опубликованного снимка для явной очистки под эксклюзивной блокировкой. */
  async liveSegments(roots: readonly (string | null)[]): Promise<Set<string>> {
    const found = new Set<string>();
    const pending = roots.filter((root): root is string => root !== null);
    while (pending.length) {
      const hash = pending.pop()!;
      if (found.has(hash)) continue;
      found.add(hash);
      const segment = await this.segment(hash);
      if (segment.type === "branch") pending.push(...Object.values(segment.children));
      else
        for (const [, value] of segment.entries) {
          if (
            value !== null &&
            !Array.isArray(value) &&
            typeof value === "object" &&
            typeof value.root === "string" &&
            Object.keys(value).length === 1
          )
            pending.push(hashSchema.parse(value.root));
        }
    }
    return found;
  }

  private save(segment: Segment): string {
    invariant(
      Buffer.byteLength(JSON.stringify(segment, null, 2) + "\n") <= SEGMENT_BYTES,
      "STORAGE_INDEX_ENTRY_TOO_LARGE",
      "Одна индексируемая запись превышает размер сегмента",
      4,
    );
    const normalized = canonical(segment) as Segment;
    const hash = digest(normalized);
    this.prepared.set(hash, normalized);
    return hash;
  }

  private async change(
    root: string | null,
    changes: [string, JsonValue | undefined][],
    depth: number,
  ): Promise<string | null> {
    if (!changes.length) return root;
    const previous = root ? await this.segment(root) : undefined;
    if (!previous || previous.type === "leaf") {
      const values = new Map(previous?.entries ?? []);
      for (const [key, value] of changes) {
        if (value === undefined) values.delete(key);
        else values.set(key, value);
      }
      if (!values.size) return null;
      const entries = [...values].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const leaf: Segment = { schemaVersion: 1, type: "leaf", entries };
      if (
        entries.length <= LEAF_ENTRIES &&
        Buffer.byteLength(JSON.stringify(leaf, null, 2) + "\n") <= SEGMENT_BYTES
      )
        return this.save(leaf);
      invariant(
        depth < 64,
        "STORAGE_INDEX_ENTRY_TOO_LARGE",
        "Индексируемое значение нельзя разделить на ограниченные сегменты",
        4,
      );
      return this.branch({}, entries, depth);
    }
    invariant(depth < 64, "STORAGE_INDEX_CORRUPT", "Неверная глубина ветви", 5);
    return this.branch(previous.children, changes, depth);
  }

  private async branch(
    children: Record<string, string>,
    changes: [string, JsonValue | undefined][],
    depth: number,
  ) {
    const next = { ...children };
    const groups = new Map<string, [string, JsonValue | undefined][]>();
    for (const change of changes) {
      const nibble = keyHash(change[0])[depth]!;
      const group = groups.get(nibble) ?? [];
      group.push(change);
      groups.set(nibble, group);
    }
    for (const [nibble, group] of groups) {
      const hash = await this.change(next[nibble] ?? null, group, depth + 1);
      if (hash) next[nibble] = hash;
      else delete next[nibble];
    }
    return Object.keys(next).length
      ? this.save({ schemaVersion: 1, type: "branch", children: next })
      : null;
  }

  changes(roots: readonly (string | null)[]): FileChange[] {
    // Отбрасываем промежуточные версии, созданные при нескольких изменениях одного дерева.
    const reachable = new Set<string>();
    const visit = (value: JsonValue): void => {
      if (typeof value === "string" && this.prepared.has(value) && !reachable.has(value)) {
        reachable.add(value);
        visit(this.prepared.get(value)!);
      } else if (Array.isArray(value)) value.forEach(visit);
      else if (value !== null && typeof value === "object") Object.values(value).forEach(visit);
    };
    roots.forEach(visit);
    for (const hash of this.prepared.keys()) if (!reachable.has(hash)) this.prepared.delete(hash);
    return [...this.prepared].map(([hash, after]) => ({ path: segmentPath(hash), after }));
  }

  /** Только после успешной публикации WAL сегменты становятся доступны другим снимкам. */
  published(): void {
    for (const [hash, segment] of this.prepared) remember(`${this.root}\0${hash}`, segment);
    this.prepared.clear();
  }
}
