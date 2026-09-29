import { productContextQuerySchema, productListQuerySchema } from "../../domain/product.js";
import type {
  ProductContext,
  ProductContextQuery,
  ProductList,
  ProductListQuery,
  ProductOverview,
  ProductSaved,
} from "../../domain/product.js";
import { parse } from "../../domain/validation.js";
import { invariant, AppError } from "../../shared/errors.js";
import { ProductService } from "./service.js";
import { productAddresses, resolveProductAddress } from "../../domain/product-addresses.js";
import { assertProductKey } from "../../domain/product-addresses.js";
import { productCatalog } from "./catalog.js";
import { buildProductOverview, readOverviewSources } from "./overview.js";
import { ProductRepository } from "../../storage/product.js";
import {
  productEntitiesQuerySchema,
  updateImplementationSchema,
} from "../../domain/product-implementation.js";
import type {
  ProductEntitiesQuery,
  ProductEntity,
  UpdateImplementation,
} from "../../domain/product-implementation.js";
import { actorSchema } from "../../domain/validation.js";
import { contractBasis } from "./model.js";
import { readEntityCatalog, resolveEntity, assertEntityKeyAvailable } from "../entities/catalog.js";
import { syncImplementationRelations } from "../entities/owned-relations.js";

/** Выборки требований и реализаций; готовность реализации определяется задачами. */
export class ProductQueries extends ProductService {
  async entities(input: ProductEntitiesQuery = {}) {
    const query = parse(productEntitiesQuerySchema, input, "список продуктовых целей");
    return this.workspace.locked(async (owned) => {
      const catalog = await productCatalog(this.workspace, owned);
      const addresses = catalog.items.map((entry) => ({ ...entry, name: entry.title }));
      const applicationId = query.application
        ? resolveProductAddress(addresses, query.application, "application").id
        : undefined;
      const ids = query.refs
        ? new Set(query.refs.map((ref) => resolveProductAddress(addresses, ref).id))
        : undefined;
      const needle = query.q?.trim().toLocaleLowerCase();
      const matches = catalog.items
        .filter(
          (entry) =>
            (!query.kind || entry.kind === query.kind) &&
            (!applicationId || entry.applicationId === applicationId) &&
            (query.implementationTarget === undefined ||
              (entry.kind === "implementation" &&
                (query.implementationTarget === "feature"
                  ? entry.scenarioId === null
                  : entry.scenarioId !== null))) &&
            (!ids || ids.has(entry.id)) &&
            (query.active === undefined || entry.active === (query.active === "true")) &&
            (!needle ||
              `${entry.key ?? ""} ${entry.title} ${entry.applicationName ?? ""} ${entry.targetKey ?? ""} ${entry.targetName ?? ""}`
                .toLocaleLowerCase()
                .includes(needle)),
        )
        .sort(
          (left, right) =>
            Number(right.key?.toLocaleLowerCase() === needle) -
              Number(left.key?.toLocaleLowerCase() === needle) ||
            (left.key ?? left.title).localeCompare(right.key ?? right.title, "ru", {
              numeric: true,
            }) ||
            left.id.localeCompare(right.id),
        );
      const next = query.offset + query.limit;
      return {
        items: matches.slice(query.offset, next),
        total: matches.length,
        nextOffset: next < matches.length ? next : null,
        version: catalog.fingerprint,
      };
    });
  }

  async entity(ref: string): Promise<ProductEntity> {
    return this.workspace.locked(async (owned) => {
      const catalog = await productCatalog(this.workspace, owned);
      const entities = await readEntityCatalog(this.workspace, owned);
      const known =
        entities.entries.some(
          (entry) => entry.ref.id === ref || entry.key === ref || entry.aliases.includes(ref),
        ) || ref.includes(":");
      if (known) {
        try {
          ref = resolveEntity(entities, ref, [
            "product",
            "feature",
            "scenario",
            "application",
            "implementation",
            "document",
          ]).ref.id;
        } catch (error) {
          if (error instanceof AppError && error.code === "AMBIGUOUS_ENTITY_REFERENCE")
            throw new AppError("AMBIGUOUS_PRODUCT_KEY", error.message, 4, error.details);
          throw error;
        }
      }
      if (!catalog.items.some((entry) => entry.id === ref || entry.key === ref)) {
        const scope = (await new ProductRepository(this.workspace).all()).find(
          (entry) => entry.id === ref && entry.fields.kind === "scope",
        );
        if (scope) {
          const { requests: _requests, events: _events, ...view } = scope;
          return view;
        }
      }
      const id = resolveProductAddress(
        catalog.items.map((entry) => ({ ...entry, name: entry.title })),
        ref,
      ).id;
      const summary = catalog.items.find((entry) => entry.id === id)!;
      const canonicalRef =
        summary.key && catalog.items.filter((entry) => entry.key === summary.key).length === 1
          ? summary.key
          : summary.id;
      const entity = {
        ...(await new ProductRepository(this.workspace).entity(summary)),
        canonicalRef,
      };
      if (entity.fields.kind === "implementation" && summary.status)
        return { ...entity, fields: { ...entity.fields, status: summary.status } };
      return entity;
    });
  }

  /** Независимая ревизия реализации не конфликтует с правкой соседнего вклада. */
  async updateImplementation(
    input: UpdateImplementation,
    defaultActor: string,
  ): Promise<ProductSaved> {
    const command = parse(updateImplementationSchema, input, "изменение реализации");
    invariant(
      command.title !== undefined ||
        command.description !== undefined ||
        command.status !== undefined ||
        command.key !== undefined,
      "INVALID_ARGUMENT",
      "Изменения реализации не заданы",
    );
    const actor = parse(actorSchema, command.actor ?? defaultActor, "автор");
    return this.workspace.mutate("implementation", command, actor, async (owned) => {
      const repository = new ProductRepository(this.workspace);
      const records = await repository.ensureKeys(owned);
      const reservations = new Map<string, string[]>();
      for (const scope of records) {
        if (scope.fields.kind !== "scope") continue;
        for (const entry of scope.fields.contracts) {
          const stored = await repository.implementation(
            scope.fields.applicationId,
            entry.id,
            entry.scenarioId !== null,
          );
          reservations.set(stored.id, stored.reservedKeys ?? []);
        }
      }
      const selected = resolveProductAddress(
        productAddresses(records),
        command.ref,
        "implementation",
      );
      const scope = records.find(
        (entry) =>
          entry.fields.kind === "scope" &&
          entry.fields.contracts.some((contract) => contract.id === selected.id),
      )!;
      invariant(scope.fields.kind === "scope", "INVALID_DATA", "Не найден состав", 5);
      const contract = scope.fields.contracts.find((entry) => entry.id === selected.id)!;
      const record = await repository.implementation(
        scope.fields.applicationId,
        selected.id,
        contract.scenarioId !== null,
      );
      invariant(
        record.revision === command.ifRevision,
        "REVISION_CONFLICT",
        "Реализация изменилась. Перечитайте запись.",
        4,
        { actual: record.revision },
      );
      invariant(
        record.fields.active || command.key !== undefined,
        "INVALID_REFERENCE",
        "Снятая реализация доступна для чтения и исправления ключа",
        4,
      );
      if (command.key) {
        assertEntityKeyAvailable(await readEntityCatalog(this.workspace, owned), command.key, {
          kind: "implementation",
          id: record.id,
        });
        invariant(
          ![...reservations].some(([id, keys]) => id !== record.id && keys.includes(command.key!)),
          "ALREADY_EXISTS",
          "Ключ зарезервирован другой реализацией",
          4,
        );
        assertProductKey(command.key, "implementation", record.id, records);
      }
      const fields = {
        ...record.fields,
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.description === undefined ? {} : { description: command.description }),
        ...(command.status === undefined ? {} : { status: command.status }),
      };
      if (command.status !== undefined) fields.basis = contractBasis(fields, records);
      const key = command.key ?? record.key;
      const result = { id: record.id, revision: record.revision + 1, ...(key ? { key } : {}) };
      const now = new Date().toISOString();
      await repository.saveImplementation(
        {
          ...record,
          ...result,
          fields,
          updatedAt: now,
          updatedBy: actor,
          reservedKeys: [
            ...new Set([
              ...(record.reservedKeys ?? []),
              ...(record.key && record.key !== key ? [record.key] : []),
            ]),
          ],
          events: [...record.events, { revision: result.revision, actor, at: now }],
          requests: {},
        },
        owned,
      );
      if (this.workspace.storageSession)
        await syncImplementationRelations(
          this.workspace,
          await repository.implementation(
            scope.fields.applicationId,
            record.id,
            record.fields.scenarioId !== null,
          ),
        );
      return result;
    });
  }

  /**
   * Прежняя карта продукта и общий срез проекта из одного чтения под блокировкой.
   * Чтение не выполняет мутаций предметных данных; ошибка источника прерывает обзор.
   */
  async overview(): Promise<ProductOverview> {
    return this.workspace.locked(async (owned) => {
      const sources = await readOverviewSources(this.workspace, owned);
      return buildProductOverview(sources, new Date().toISOString());
    });
  }

  async list(input: ProductListQuery = {}): Promise<ProductList> {
    const query = parse(productListQuerySchema, input, "выборка продукта");
    const state = await this.state();
    const id = query.id
      ? resolveProductAddress(productAddresses(state.records), query.id).id
      : undefined;
    const needle = query.q?.trim().toLocaleLowerCase();
    const records = state.records.filter(
      (record) =>
        (!query.kind || record.fields.kind === query.kind) &&
        (!id || record.id === id) &&
        (!needle ||
          `${record.key ?? ""} ${JSON.stringify(record.fields)}`
            .toLocaleLowerCase()
            .includes(needle)),
    );
    const nextOffset = query.offset + query.limit;
    return {
      version: state.version,
      total: records.length,
      items: records.slice(query.offset, nextOffset),
      nextOffset: nextOffset < records.length ? nextOffset : null,
    };
  }

  async context(input: ProductContextQuery = {}): Promise<ProductContext> {
    const query = parse(productContextQuerySchema, input, "контекст продукта");
    const state = await this.state();
    const addresses = productAddresses(state.records);
    if (query.id) query.id = resolveProductAddress(addresses, query.id).id;
    if (query.applicationId)
      query.applicationId = resolveProductAddress(addresses, query.applicationId, "application").id;
    const selected = state.records.find((record) => record.id === query.id);
    const contractScope = state.records.find(
      (record) =>
        record.fields.kind === "scope" &&
        record.fields.contracts.some((contract) => contract.id === query.id),
    );
    const selectedContract =
      contractScope?.fields.kind === "scope"
        ? contractScope.fields.contracts.find((contract) => contract.id === query.id)
        : undefined;
    invariant(
      !query.id || selected || selectedContract,
      "PRODUCT_RECORD_NOT_FOUND",
      "Область контекста не найдена",
      3,
    );
    const applicationId =
      query.applicationId ??
      (selected?.fields.kind === "application"
        ? selected.id
        : contractScope?.fields.kind === "scope"
          ? contractScope.fields.applicationId
          : undefined);
    invariant(
      !applicationId ||
        state.records.some(
          (record) => record.id === applicationId && record.fields.kind === "application",
        ),
      "INVALID_REFERENCE",
      "Приложение контекста не найдено",
    );
    const featureIds = new Set<string>();
    const scenarioIds = new Set<string>();
    if (selectedContract) {
      featureIds.add(selectedContract.featureId);
      if (selectedContract.scenarioId) scenarioIds.add(selectedContract.scenarioId);
      invariant(
        contractScope?.fields.kind === "scope" &&
          contractScope.fields.applicationId === applicationId,
        "INVALID_REFERENCE",
        "Контракт принадлежит другому приложению",
      );
    }
    if (selected?.fields.kind === "feature") {
      featureIds.add(selected.id);
      state.records.forEach((record) => {
        if (record.fields.kind === "scenario" && record.fields.featureId === selected.id)
          scenarioIds.add(record.id);
      });
    }
    if (selected?.fields.kind === "scenario") {
      featureIds.add(selected.fields.featureId);
      scenarioIds.add(selected.id);
    }
    if (applicationId && !featureIds.size) {
      for (const record of state.records)
        if (record.fields.kind === "scope" && record.fields.applicationId === applicationId) {
          for (const contract of record.fields.contracts.filter((entry) => entry.active)) {
            featureIds.add(contract.featureId);
            if (contract.scenarioId) scenarioIds.add(contract.scenarioId);
          }
        }
    }
    const contractIds = new Set<string>();
    const applications = new Set<string>(applicationId ? [applicationId] : []);
    const scopes = state.records.flatMap((record) => {
      if (record.fields.kind !== "scope") return [];
      const contracts = record.fields.contracts.filter(
        (contract) =>
          (contract.active || contract.id === query.id) &&
          (applicationId === undefined ||
            (record.fields.kind === "scope" && record.fields.applicationId === applicationId)) &&
          (contract.scenarioId
            ? scenarioIds.has(contract.scenarioId)
            : featureIds.has(contract.featureId)),
      );
      if (!contracts.length) return [];
      applications.add(record.fields.applicationId);
      contracts.forEach((contract) => contractIds.add(contract.id));
      return [
        {
          record: { ...record, fields: { ...record.fields, contracts } },
          reasons: ["Реализация выбранной области"],
        },
      ];
    });
    const records = state.records.flatMap((record) => {
      const reasons: string[] = [];
      if (record.fields.kind === "passport") reasons.push("Паспорт продукта");
      if (record.id === query.id) reasons.push("Выбранная запись");
      if (featureIds.has(record.id)) reasons.push("Общий контракт фичи");
      if (scenarioIds.has(record.id)) reasons.push("Сценарий области");
      if (applications.has(record.id)) reasons.push("Проект-реализатор");
      if (record.fields.kind === "document")
        for (const link of record.fields.links) {
          if (
            link.kind === "product" ||
            (link.kind === "feature" && featureIds.has(link.id)) ||
            (link.kind === "scenario" && scenarioIds.has(link.id)) ||
            (link.kind === "application" && applications.has(link.id)) ||
            (link.kind === "implementation" && contractIds.has(link.id))
          )
            reasons.push(`Связь: ${link.kind}${"id" in link ? `/${link.id}` : ""}`);
        }
      return reasons.length && record.fields.kind !== "scope" ? [{ record, reasons }] : [];
    });
    return {
      productId: state.productId,
      version: state.version,
      records: [...records, ...scopes],
      readiness: state.readiness.filter(
        (entry) => featureIds.has(entry.id) || scenarioIds.has(entry.id),
      ),
    };
  }
}
