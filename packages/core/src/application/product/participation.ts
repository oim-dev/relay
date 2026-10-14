import {
  productImplementationDetailSchema,
  productParticipationPageSchema,
  productParticipationQuerySchema,
  productParticipationReplaceSchema,
  productParticipationSavedSchema,
} from "@relay/contracts/product-participation";
import type {
  ProductImplementationDetail,
  ProductParticipationPage,
  ProductParticipationQuery,
  ProductParticipationReplace,
  ProductParticipationSaved,
} from "@relay/contracts/product-participation";
import { actorSchema, parse } from "../../domain/validation.js";
import { productRefSchema } from "../../domain/product.js";
import { resolveProductAddress } from "../../domain/product-addresses.js";
import { BoardTaskRepository } from "../../storage/board-tasks.js";
import { invariant } from "../../shared/errors.js";
import { ProductService } from "./service.js";
import { productState, productVersion } from "./model.js";
import {
  assertProductPageVersion,
  productReadVersion,
  publicProductCard,
  readProductSelection,
} from "./read-model.js";

/** Состав читается компактно; изменение выполняется существующей границей записи продукта. */
export class ProductParticipation extends ProductService {
  async participation(input: ProductParticipationQuery): Promise<ProductParticipationPage> {
    const query = parse(productParticipationQuerySchema, input, "страница состава приложения");
    return this.workspace.locked(async (owned) => {
      const { repository, records, addresses } = await readProductSelection(this.workspace, owned);
      const tasks = await new BoardTaskRepository(this.workspace).all();
      const snapshotVersion = productReadVersion([
        "product-participation/1",
        repository.productId,
        records,
        tasks,
      ]);
      assertProductPageVersion(query.version, snapshotVersion);
      const application = resolveProductAddress(addresses, query.application, "application");
      const scope = records.find(
        (entry) => entry.fields.kind === "scope" && entry.fields.applicationId === application.id,
      );
      const raw = scope?.fields.kind === "scope" ? scope.fields.contracts : [];
      const state = productState(repository.productId, records, tasks);
      const computed = state.records.find((entry) => entry.id === scope?.id);
      const statuses = new Map(
        computed?.fields.kind === "scope"
          ? computed.fields.contracts.map((entry) => [entry.id, entry.status])
          : [],
      );
      const next = query.offset + query.limit;
      return productParticipationPageSchema.parse({
        application: publicProductCard(addresses, application.id),
        scopeId: scope?.id ?? null,
        revision: scope?.revision ?? 0,
        version: state.version,
        snapshotVersion,
        total: raw.length,
        nextOffset: next < raw.length ? next : null,
        items: raw.slice(query.offset, next).map((entry) => ({
          ...publicProductCard(addresses, entry.id),
          revision: entry.revision ?? 1,
          implementationTarget: entry.scenarioId === null ? "feature" : "scenario",
          target: publicProductCard(addresses, entry.scenarioId ?? entry.featureId),
          feature: publicProductCard(addresses, entry.featureId),
          active: entry.active,
          status: statuses.get(entry.id) ?? "none",
          savedStatus: entry.status,
        })),
      });
    });
  }

  async replaceParticipation(
    input: ProductParticipationReplace,
    defaultActor: string,
  ): Promise<ProductParticipationSaved> {
    const command = parse(productParticipationReplaceSchema, input, "замена состава приложения");
    const actor = parse(actorSchema, command.actor ?? defaultActor, "автор");
    return this.workspace.mutate("product-participation", command, actor, async (owned) => {
      const { repository, records, addresses } = await readProductSelection(this.workspace, owned);
      invariant(
        command.ifVersion === productVersion(records),
        "REVISION_CONFLICT",
        "Продукт изменился после чтения",
        4,
      );
      const application = resolveProductAddress(addresses, command.application, "application");
      const scope = records.find(
        (entry) => entry.fields.kind === "scope" && entry.fields.applicationId === application.id,
      );
      invariant(
        command.ifRevision === (scope?.revision ?? 0),
        "REVISION_CONFLICT",
        "Состав изменился после чтения",
        4,
        { actual: scope?.revision ?? 0, expected: command.ifRevision },
      );
      const previous = scope?.fields.kind === "scope" ? scope.fields.contracts : [];
      const contracts = command.selections.map((selection) => {
        if (selection.kind === "existing") {
          const selected = resolveProductAddress(addresses, selection.ref, "implementation");
          const contract = previous.find((entry) => entry.id === selected.id);
          invariant(contract, "INVALID_REFERENCE", "Реализация принадлежит другому приложению", 4);
          return {
            featureId: contract.featureId,
            scenarioId: contract.scenarioId,
            title: contract.title,
            description: contract.description,
            status: contract.status,
          };
        }
        const target = resolveProductAddress(addresses, selection.target);
        invariant(
          target.kind === "feature" || target.kind === "scenario",
          "INVALID_REFERENCE",
          "Новый вклад требует фичу или сценарий",
          4,
        );
        const record = records.find((entry) => entry.id === target.id)!;
        const featureId = record.fields.kind === "scenario" ? record.fields.featureId : record.id;
        const scenarioId = record.fields.kind === "scenario" ? record.id : null;
        invariant(
          !previous.some(
            (entry) => entry.featureId === featureId && entry.scenarioId === scenarioId,
          ),
          "ALREADY_EXISTS",
          "Пара уже существует, в том числе при снятом участии. Выберите её через existing, чтобы сохранить содержание.",
          4,
        );
        return {
          featureId,
          scenarioId,
          title: selection.title,
          description: selection.description,
          status: selection.status ?? "none",
        };
      });
      // Вложенная граница использует ту же StorageSession: одна проверка, запись состава,
      // согласование отношений и одна публикация WAL, без промежуточных implementation-create.
      const saved = await this.mutate(
        {
          action: scope ? "update" : "create",
          ...(scope ? { id: scope.id } : {}),
          fields: { kind: "scope", applicationId: application.id, contracts },
          ifRevision: command.ifRevision,
          ifVersion: command.ifVersion,
          requestId: command.requestId,
          actor,
        },
        actor,
      );
      return productParticipationSavedSchema.parse({
        application: publicProductCard(addresses, application.id),
        scopeId: saved.id,
        ...(saved.key === undefined ? {} : { key: saved.key }),
        revision: saved.revision,
        version: productVersion(await repository.all()),
        selected: contracts.length,
      });
    });
  }

  /** Совместимые full/entity ответы не меняются: новая проекция раскрывает raw status явно. */
  async implementation(ref: string): Promise<ProductImplementationDetail> {
    ref = parse(productRefSchema, ref, "адрес реализации");
    return this.workspace.locked(async (owned) => {
      const { repository, records, addresses, implementations } = await readProductSelection(
        this.workspace,
        owned,
      );
      const selected = resolveProductAddress(addresses, ref, "implementation");
      const scope = records.find(
        (entry) =>
          entry.fields.kind === "scope" &&
          entry.fields.contracts.some((contract) => contract.id === selected.id),
      )!;
      invariant(scope.fields.kind === "scope", "INVALID_DATA", "Состав реализации не найден", 5);
      const contract = scope.fields.contracts.find((entry) => entry.id === selected.id)!;
      const record =
        implementations.get(selected.id) ??
        (await repository.implementation(
          scope.fields.applicationId,
          selected.id,
          contract.scenarioId !== null,
        ));
      const state = productState(
        repository.productId,
        records,
        await new BoardTaskRepository(this.workspace).all(),
      );
      const computed = state.records.find((entry) => entry.id === scope.id)!;
      invariant(computed.fields.kind === "scope", "INVALID_DATA", "Состав реализации не найден", 5);
      const { events: _events, requests: _requests, ...view } = record;
      return productImplementationDetailSchema.parse({
        ...view,
        canonicalRef: selected.key ?? `implementation:${selected.id}`,
        implementationTarget: contract.scenarioId === null ? "feature" : "scenario",
        savedStatus: record.fields.status,
        fields: {
          ...record.fields,
          status: computed.fields.contracts.find((entry) => entry.id === selected.id)!.status,
        },
      });
    });
  }
}
