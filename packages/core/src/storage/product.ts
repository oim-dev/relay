import { dirname, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { stat } from "node:fs/promises";
import { productRecordSchema, productIdSchema } from "../domain/product.js";
import type { ProductRecord, ProductContract } from "../domain/product.js";
import { decodeImplementation, encodeImplementation } from "../domain/product-implementation.js";
import type {
  ProductImplementation,
  ProductEntity,
  ProductEntitySummary,
} from "../domain/product-implementation.js";
import { invariant } from "../shared/errors.js";
import { directories, exists, jsonFiles, readJson } from "./files.js";
import { decodeProduct, encodeProduct } from "./product-codec.js";
import type { Workspace } from "./workspace.js";
import { nextProductKey, productAddresses } from "../domain/product-addresses.js";
import { defaultBoardPrefix } from "../domain/board.js";
import { ProductTransaction } from "./product-transaction.js";
import { EntityDeletionRepository } from "./entity-deletion.js";
import * as unified from "./unified-adapter.js";

export const PRODUCT_DIRECTORIES = {
  passport: "",
  feature: "features",
  scenario: "scenarios",
  application: "applications",
  scope: "scopes",
  document: "documents",
} as const;
const manifestSchema = productRecordSchema.omit({ fields: true }).extend({
  version: z.literal(3),
  storage: z.literal("references"),
  fields: z.strictObject({
    kind: z.literal("scope"),
    applicationId: productIdSchema,
    contracts: z.array(
      z.strictObject({ id: productIdSchema, directory: z.enum(["features", "scenarios"]) }),
    ),
  }),
});
const contractValue = (entry: ProductContract) => {
  return JSON.stringify([
    entry.id,
    entry.key ?? null,
    entry.featureId,
    entry.scenarioId,
    entry.title,
    entry.description,
    entry.status,
    entry.active,
    entry.basis,
  ]);
};

/** Физические пути и связи используют ID. Состав — совместимая проекция отдельных реализаций. */
export class ProductRepository {
  private readonly decodedImplementations = new Map<string, ProductImplementation>();
  readonly root: string;
  readonly productId: string;
  constructor(readonly workspace: Workspace) {
    this.root = join(dirname(workspace.configPath), "product");
    this.productId =
      workspace.storageProductId ??
      (workspace.config.projectId && /^[A-Za-z0-9]{8}$/.test(workspace.config.projectId)
        ? workspace.config.projectId
        : `product_${createHash("sha256")
            .update(workspace.config.projectId ?? workspace.root)
            .digest("hex")
            .slice(0, 32)}`);
  }

  private async sources(): Promise<string[]> {
    const paths: string[] = [];
    for (const directory of Object.values(PRODUCT_DIRECTORIES)) {
      for (const filename of await jsonFiles(join(this.root, directory))) {
        if (!filename.startsWith(".")) paths.push(join(this.root, directory, filename));
      }
    }
    for (const id of await directories(join(this.root, "applications"))) {
      productIdSchema.parse(id);
      const directory = join(this.root, "applications", id);
      for (const filename of ["application.json", "scope.json"]) {
        const path = join(directory, filename);
        if (await exists(path)) paths.push(path);
      }
    }
    return paths;
  }

  implementationPath(
    applicationId: string,
    contract: Pick<ProductContract, "id" | "scenarioId">,
  ): string {
    return `applications/${applicationId}/${contract.scenarioId === null ? "features" : "scenarios"}/${contract.id}.json`;
  }

  private async decode(value: unknown, path: string): Promise<ProductRecord> {
    if (
      typeof value === "object" &&
      value !== null &&
      "storage" in value &&
      value.storage === "references"
    ) {
      const manifest = manifestSchema.parse(value);
      const contracts: ProductContract[] = [];
      const refs = new Map(manifest.fields.contracts.map((ref) => [ref.id, ref]));
      invariant(
        refs.size === manifest.fields.contracts.length,
        "INVALID_DATA",
        "Повтор ID реализации в составе",
        5,
      );
      // После объединения веток отдельный файл не должен исчезать из чтения из-за старого списка.
      for (const directory of ["features", "scenarios"] as const) {
        for (const filename of await jsonFiles(
          join(this.root, "applications", manifest.fields.applicationId, directory),
        )) {
          const id = productIdSchema.parse(filename.slice(0, -5));
          const existing = refs.get(id);
          invariant(
            !existing || existing.directory === directory,
            "INVALID_DATA",
            "ID реализации находится в двух каталогах",
            5,
          );
          refs.set(id, { id, directory });
        }
      }
      for (const ref of refs.values()) {
        const implPath = join(
          this.root,
          "applications",
          manifest.fields.applicationId,
          ref.directory,
          `${ref.id}.json`,
        );
        const implementation = decodeImplementation(await readJson(implPath, 16 * 1024 * 1024));
        this.decodedImplementations.set(implementation.id, implementation);
        invariant(
          implementation.id === ref.id &&
            implementation.productId === this.productId &&
            implementation.fields.applicationId === manifest.fields.applicationId &&
            (implementation.fields.scenarioId === null ? "features" : "scenarios") ===
              ref.directory,
          "INVALID_DATA",
          "Неверная принадлежность реализации",
          5,
        );
        const { kind: _kind, applicationId: _app, ...fields } = implementation.fields;
        contracts.push({
          ...fields,
          id: implementation.id,
          ...(implementation.key ? { key: implementation.key } : {}),
          revision: implementation.revision,
        });
      }
      const { storage: _storage, ...record } = manifest;
      return productRecordSchema.parse({
        ...record,
        version: 1,
        fields: { ...manifest.fields, contracts },
      });
    }
    return decodeProduct(value, path);
  }

  async all(): Promise<ProductRecord[]> {
    if (!this.workspace.storageSession && (await this.workspace.hasUnifiedStorage()))
      return this.workspace.locked(() => this.all());
    if (this.workspace.storageSession)
      return unified.productRecords(this.workspace, this.productId);
    this.decodedImplementations.clear();
    const records: ProductRecord[] = [];
    for (const path of await this.sources()) {
      const record = await this.decode(await readJson(path, 16 * 1024 * 1024), path);
      const location = relative(this.root, path);
      const allowed = [
        `${record.id}.json`,
        `${PRODUCT_DIRECTORIES[record.fields.kind]}/${record.id}.json`,
        this.path(record),
      ];
      invariant(
        record.productId === this.productId && allowed.includes(location),
        "INVALID_DATA",
        `Неверная принадлежность записи: ${path}`,
        5,
      );
      invariant(
        !records.some((entry) => entry.id === record.id),
        "INVALID_DATA",
        `Дублирующийся ID: ${path}`,
        5,
      );
      records.push(record);
    }
    return records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Единый снимок предоставляет метаданные отдельных реализаций без повторного чтения файлов. */
  async snapshot(assertOwned: () => void, persistKeys = false) {
    if (this.workspace.storageSession)
      return {
        records: await this.all(),
        implementations: new Map(
          (await unified.implementationRecords(this.workspace, this.productId)).map((entry) => [
            entry.id,
            entry,
          ]),
        ),
      };
    const records = await this.ensureKeys(assertOwned, persistKeys);
    if (!persistKeys)
      for (const record of records) {
        if (record.fields.kind !== "scope") continue;
        for (const contract of record.fields.contracts) {
          const implementation = this.decodedImplementations.get(contract.id);
          if (implementation && contract.key) implementation.key = contract.key;
        }
      }
    return { records, implementations: new Map(this.decodedImplementations) };
  }

  path(record: ProductRecord): string {
    if (record.fields.kind === "application") return `applications/${record.id}/application.json`;
    if (record.fields.kind === "scope")
      return `applications/${record.fields.applicationId}/scope.json`;
    return record.fields.kind === "passport"
      ? `${record.id}.json`
      : `${PRODUCT_DIRECTORIES[record.fields.kind]}/${record.id}.json`;
  }

  /** Однократное закрепление ключей на диске; техническая миграция не меняет требования. */
  async ensureKeys(assertOwned: () => void, persist = false): Promise<ProductRecord[]> {
    if (this.workspace.storageSession) return this.all();
    if (persist) this.workspace.assertWritableStorage();
    const records = await this.all();
    const ordered = [...records].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    for (const record of ordered) {
      const kind = record.fields.kind;
      if (
        record.key ||
        !["passport", "feature", "scenario", "application", "document"].includes(kind)
      )
        continue;
      record.key =
        kind === "passport"
          ? "PRODUCT"
          : kind === "application" && record.fields.kind === "application"
            ? (record.fields.prefix ?? defaultBoardPrefix(record.fields.slug))
            : nextProductKey(kind as "feature" | "scenario" | "document", records);
      if (persist) await this.save(record, false, assertOwned);
    }
    const keys = new Set([
      ...(await new EntityDeletionRepository(this.workspace).reservedKeys()),
      ...productAddresses(records).flatMap((entry) => (entry.key ? [entry.key] : [])),
    ]);
    if (
      records.some(
        (entry) =>
          entry.fields.kind === "scope" && entry.fields.contracts.some((contract) => !contract.key),
      )
    ) {
      for (const scope of records) {
        if (scope.fields.kind !== "scope") continue;
        for (const contract of scope.fields.contracts) {
          const path = join(
            this.root,
            this.implementationPath(scope.fields.applicationId, contract),
          );
          if (!(await exists(path))) continue;
          const previous = decodeImplementation(await readJson(path, 16 * 1024 * 1024));
          previous.reservedKeys?.forEach((key) => keys.add(key));
        }
      }
    }
    for (const record of ordered) {
      if (record.fields.kind !== "scope") continue;
      const appId = record.fields.applicationId;
      const app = records.find((entry) => entry.id === appId);
      let changed = false;
      for (const contract of record.fields.contracts) {
        if (contract.key) continue;
        const target = records.find(
          (entry) => entry.id === (contract.scenarioId ?? contract.featureId),
        );
        invariant(app?.key && target?.key, "INVALID_REFERENCE", "Не найдена цель реализации", 5);
        const applicationPrefix =
          app.fields.kind === "application"
            ? (app.fields.prefix ?? defaultBoardPrefix(app.fields.slug))
            : app.key;
        const prefix = `${applicationPrefix}-${contract.scenarioId === null ? "FI" : "SI"}`;
        const suffix = Number(target.key.split("-").at(-1));
        let number = Number.isSafeInteger(suffix) && suffix > 0 ? suffix : 1;
        while (keys.has(`${prefix}-${number}`)) number++;
        contract.key = `${prefix}-${number}`;
        contract.revision ??= 1;
        keys.add(contract.key);
        changed = true;
      }
      if (persist && (changed || !(await exists(join(this.root, this.path(record))))))
        await this.save(record, false, assertOwned);
    }
    return persist ? this.all() : records;
  }

  /** Пути уже декодированных источников для явного переноса; неизвестные файлы не удаляются. */
  async migrationSources() {
    return this.sources();
  }

  /** Явная миграция переносит также старые записи, которым ключи уже назначены. */
  async migrate(assertOwned: () => void): Promise<number> {
    this.workspace.assertWritableStorage();
    if (this.workspace.storageSession) return 0;
    let migrated = 0;
    for (const path of await this.sources()) {
      const raw = await readJson(path, 16 * 1024 * 1024);
      const record = await this.decode(raw, path);
      if (
        relative(this.root, path) === this.path(record) &&
        typeof raw === "object" &&
        raw !== null &&
        "version" in raw &&
        raw.version === (record.fields.kind === "document" ? 4 : 3) &&
        (record.fields.kind !== "scope" || "storage" in raw)
      )
        continue;
      await this.save(record, false, assertOwned);
      migrated++;
    }
    await this.ensureKeys(assertOwned);
    return migrated;
  }

  async implementation(
    applicationId: string,
    id: string,
    scenario: boolean,
  ): Promise<ProductImplementation> {
    if (this.workspace.storageSession) {
      const record = (await unified.implementationRecords(this.workspace, this.productId)).find(
        (entry) => entry.id === id,
      );
      invariant(
        record?.fields.applicationId === applicationId &&
          (record.fields.scenarioId !== null) === scenario,
        "PRODUCT_RECORD_NOT_FOUND",
        "Реализация не найдена в приложении",
        3,
      );
      return record;
    }
    const path = this.implementationPath(applicationId, {
      id,
      scenarioId: scenario ? "scenario" : null,
    });
    const record = decodeImplementation(await readJson(join(this.root, path), 16 * 1024 * 1024));
    invariant(
      record.id === id &&
        record.productId === this.productId &&
        record.fields.applicationId === applicationId,
      "INVALID_DATA",
      "Неверная принадлежность реализации",
      5,
    );
    return record;
  }

  /** Подпись файлов проверяет внешние правки без загрузки Markdown и историй. */
  async fingerprint(): Promise<string> {
    if (this.workspace.storageSession)
      return createHash("sha256")
        .update(
          JSON.stringify([
            this.workspace.storageSession.state.version,
            [...this.workspace.storageSession.files],
          ]),
        )
        .digest("hex");
    const paths = await this.sources();
    for (const app of await directories(join(this.root, "applications"))) {
      for (const kind of ["features", "scenarios"]) {
        const directory = join(this.root, "applications", app, kind);
        for (const filename of await jsonFiles(directory)) paths.push(join(directory, filename));
      }
    }
    const stamps = await Promise.all(
      paths.sort().map(async (path) => {
        const info = await stat(path, { bigint: true });
        return [
          relative(this.root, path),
          info.size.toString(),
          info.mtimeNs.toString(),
          info.ctimeNs.toString(),
        ];
      }),
    );
    return createHash("sha256").update(JSON.stringify(stamps)).digest("hex");
  }

  async entity(summary: ProductEntitySummary): Promise<ProductEntity> {
    if (this.workspace.storageSession) {
      const record =
        summary.kind === "implementation"
          ? await this.implementation(
              summary.applicationId!,
              summary.id,
              summary.scenarioId !== null,
            )
          : (await this.all()).find((entry) => entry.id === summary.id);
      invariant(record, "PRODUCT_RECORD_NOT_FOUND", "Запись продукта не найдена", 3);
      const { events: _events, requests: _requests, ...entity } = record;
      return entity;
    }
    if (summary.kind === "implementation") {
      invariant(summary.applicationId, "INVALID_DATA", "У реализации отсутствует приложение", 5);
      const {
        events: _events,
        requests: _requests,
        ...entity
      } = await this.implementation(summary.applicationId, summary.id, summary.scenarioId !== null);
      return entity;
    }
    const target =
      summary.kind === "application"
        ? `applications/${summary.id}/application.json`
        : summary.kind === "passport"
          ? `${summary.id}.json`
          : `${PRODUCT_DIRECTORIES[summary.kind]}/${summary.id}.json`;
    const choices = [
      target,
      `${PRODUCT_DIRECTORIES[summary.kind]}/${summary.id}.json`,
      `${summary.id}.json`,
    ];
    for (const candidate of choices) {
      const path = join(this.root, candidate);
      if (!(await exists(path))) continue;
      const {
        events: _events,
        requests: _requests,
        ...entity
      } = await this.decode(await readJson(path, 16 * 1024 * 1024), path);
      invariant(
        entity.id === summary.id &&
          entity.productId === this.productId &&
          entity.fields.kind === summary.kind,
        "INVALID_DATA",
        "Запись не соответствует индексу",
        5,
      );
      return entity;
    }
    invariant(false, "PRODUCT_RECORD_NOT_FOUND", "Запись продукта не найдена", 3);
  }

  async saveImplementation(record: ProductImplementation, assertOwned: () => void): Promise<void> {
    if (this.workspace.storageSession) return unified.saveImplementation(this.workspace, record);
    await new ProductTransaction(this.workspace).publish(
      [
        {
          path: this.implementationPath(record.fields.applicationId, {
            id: record.id,
            scenarioId: record.fields.scenarioId,
          }),
          after: encodeImplementation(record),
        },
      ],
      assertOwned,
    );
  }

  async save(record: ProductRecord, exclusive: boolean, assertOwned: () => void): Promise<void> {
    if (this.workspace.storageSession) return unified.saveProduct(this.workspace, record);
    await new ProductTransaction(this.workspace).publish(
      await this.prepare(record, exclusive),
      assertOwned,
    );
  }

  /** Готовит файлы без публикации для общей транзакции нескольких владельцев. */
  async prepare(
    record: ProductRecord,
    exclusive = false,
  ): Promise<{ path: string; after: unknown }[]> {
    const target = this.path(record);
    const oldPaths = [
      ...new Set([
        `${record.id}.json`,
        `${PRODUCT_DIRECTORIES[record.fields.kind]}/${record.id}.json`,
      ]),
    ].filter((path) => path !== target && !path.startsWith("/"));
    if (exclusive)
      invariant(
        !(await exists(join(this.root, target))) &&
          !(await Promise.all(oldPaths.map((path) => exists(join(this.root, path))))).some(Boolean),
        "ALREADY_EXISTS",
        "Запись уже существует",
        4,
      );
    const changes: { path: string; after: unknown }[] = [];
    if (record.fields.kind === "scope") {
      const { applicationId, contracts } = record.fields;
      for (const contract of contracts) {
        const path = this.implementationPath(applicationId, contract);
        const previous = (await exists(join(this.root, path)))
          ? decodeImplementation(await readJson(join(this.root, path), 16 * 1024 * 1024))
          : undefined;
        const { id, key, revision: _revision, ...fields } = contract;
        const oldContract = previous
          ? { ...previous.fields, id: previous.id, ...(previous.key ? { key: previous.key } : {}) }
          : undefined;
        const compared = { ...contract };
        if (previous && !previous.key) delete compared.key;
        const changed =
          previous !== undefined && contractValue(compared) !== contractValue(oldContract!);
        const revision = previous
          ? previous.revision + (changed ? 1 : 0)
          : (contract.revision ?? 1);
        const implementation: ProductImplementation = {
          version: 1,
          productId: record.productId,
          id,
          ...(key ? { key } : {}),
          revision,
          fields: { ...fields, kind: "implementation", applicationId },
          createdAt: previous?.createdAt ?? record.createdAt,
          createdBy: previous?.createdBy ?? record.createdBy,
          updatedAt: changed || !previous ? record.updatedAt : previous.updatedAt,
          updatedBy: changed || !previous ? record.updatedBy : previous.updatedBy,
          events: [
            ...(previous?.events ?? []),
            ...(changed ? [{ revision, at: record.updatedAt, actor: record.updatedBy }] : []),
          ],
          requests: previous?.requests ?? {},
          ...(previous?.reservedKeys ? { reservedKeys: previous.reservedKeys } : {}),
        };
        changes.push({ path, after: encodeImplementation(implementation) });
      }
      changes.push({
        path: target,
        after: manifestSchema.parse({
          ...record,
          version: 3,
          storage: "references",
          fields: {
            ...record.fields,
            contracts: contracts.map((entry) => ({
              id: entry.id,
              directory: entry.scenarioId === null ? "features" : "scenarios",
            })),
          },
        }),
      });
    } else changes.push({ path: target, after: encodeProduct(record) });
    for (const path of oldPaths)
      if (await exists(join(this.root, path))) changes.push({ path, after: null });
    for (const change of changes)
      invariant(
        Buffer.byteLength(JSON.stringify(change.after, null, 2) + "\n") <= 16 * 1024 * 1024,
        "RESPONSE_TOO_LARGE",
        "Запись продукта превышает 16 МиБ",
      );
    return changes;
  }
}
