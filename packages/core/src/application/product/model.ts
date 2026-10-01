import type { TaskCompletion } from "../board-tasks/completion.js";
import { createHash } from "node:crypto";
import type {
  ProductContract,
  ProductRecord,
  ProductReference,
  ProductState,
} from "../../domain/product.js";
import { invariant } from "../../shared/errors.js";
import type { BoardTaskRecord } from "../../domain/board-task.js";
import { productTaskStatuses } from "./task-progress.js";

/** Отпечаток содержимого учитывает также внешнее редактирование файлов. */
export function productVersion(records: ProductRecord[]): string {
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

/** Основание реализации не зависит от названий и редакционных метаданных. */
export function contractBasis(
  contract: Pick<ProductContract, "featureId" | "scenarioId" | "description">,
  records: ProductRecord[],
): string {
  const feature = records.find((entry) => entry.id === contract.featureId);
  const scenario = records.find((entry) => entry.id === contract.scenarioId);
  return createHash("sha256")
    .update(
      JSON.stringify([
        feature?.fields.kind === "feature" ? feature.fields.description : null,
        scenario?.fields.kind === "scenario" ? scenario.fields.description : null,
        contract.description,
      ]),
    )
    .digest("hex");
}

/** Проверяет типизированную цель, включая исторические реализации. */
export function resolveProductReference(
  reference: ProductReference,
  records: ProductRecord[],
): boolean {
  if (reference.kind === "product") return true;
  if (reference.kind === "implementation")
    return records.some(
      (record) =>
        record.fields.kind === "scope" &&
        record.fields.applicationId === reference.applicationId &&
        record.fields.contracts.some((contract) => contract.id === reference.id),
    );
  return records.some(
    (record) => record.id === reference.id && record.fields.kind === reference.kind,
  );
}

/** Валидация всего графа выполняется до публикации любого изменения. */
export function validateProduct(records: ProductRecord[]): void {
  const has = (id: string, kind: string) =>
    records.some((entry) => entry.id === id && entry.fields.kind === kind);
  const ids = new Set<string>();
  for (const record of records) {
    invariant(!ids.has(record.id), "INVALID_DATA", "Повтор ID продукта", 5);
    ids.add(record.id);
    const fields = record.fields;
    invariant(
      /^[A-Za-z0-9]{8}$/.test(record.id) ||
        record.id ===
          (fields.kind === "passport" ? "passport" : `${fields.kind}_${record.id.split("_")[1]}`),
      "INVALID_DATA",
      "ID не соответствует виду записи",
      5,
    );
    if (fields.kind === "scenario")
      invariant(
        has(fields.featureId, "feature"),
        "INVALID_REFERENCE",
        "Родительская фича не найдена",
      );
    if (fields.kind === "scope") {
      invariant(
        has(fields.applicationId, "application"),
        "INVALID_REFERENCE",
        "Приложение не найдено",
      );
      invariant(
        !records.some(
          (other) =>
            other.id !== record.id &&
            other.fields.kind === "scope" &&
            other.fields.applicationId === fields.applicationId,
        ),
        "INVALID_DATA",
        "Повтор состава приложения",
        5,
      );
      const targets = new Set<string>();
      const contractIds = new Set<string>();
      for (const contract of fields.contracts) {
        invariant(
          !ids.has(contract.id) && !records.some((entry) => entry.id === contract.id),
          "INVALID_DATA",
          "ID реализации повторяется в продукте",
          5,
        );
        ids.add(contract.id);
        invariant(!contractIds.has(contract.id), "INVALID_REFERENCE", "Повтор ID контракта");
        contractIds.add(contract.id);
        const key = `${contract.featureId}/${contract.scenarioId ?? ""}`;
        invariant(!targets.has(key), "INVALID_REFERENCE", "Повтор цели контракта");
        targets.add(key);
        invariant(
          has(contract.featureId, "feature"),
          "INVALID_REFERENCE",
          "Фича контракта не найдена",
        );
        if (contract.scenarioId !== null) {
          invariant(
            records.some(
              (entry) =>
                entry.id === contract.scenarioId &&
                entry.fields.kind === "scenario" &&
                entry.fields.featureId === contract.featureId,
            ),
            "INVALID_REFERENCE",
            "Сценарий не принадлежит фиче",
          );
          invariant(
            !contract.active ||
              fields.contracts.some(
                (parent) =>
                  parent.active &&
                  parent.featureId === contract.featureId &&
                  parent.scenarioId === null,
              ),
            "INVALID_REFERENCE",
            "Сценарий требует общего контракта фичи",
          );
        }
      }
    }
    if (fields.kind === "document") {
      const links = fields.links.map((link) => JSON.stringify(link));
      invariant(
        new Set(links).size === links.length,
        "INVALID_REFERENCE",
        "Повтор связи документа",
      );
      for (const link of fields.links)
        invariant(
          resolveProductReference(link, records),
          "INVALID_REFERENCE",
          "Цель документа не найдена в продукте",
        );
    }
  }
}

/**
 * Поднимает готовность задач через активные реализации и считает участие приложений.
 * В возвращаемых составах `contracts[].status` (тип `ProductStatus`) — вычисленная по задачам
 * готовность, а не сохранённое заявленное значение; снятые реализации получают `none`.
 */
export function productState(
  productId: string,
  records: ProductRecord[],
  tasks: BoardTaskRecord[] = [],
  /** Выполнение тех же задач, уже посчитанное в этом чтении. */
  completion?: Map<string, TaskCompletion>,
): ProductState {
  const contracts = records.flatMap((record) => {
    const fields = record.fields;
    if (fields.kind !== "scope") return [];
    return fields.contracts
      .filter((entry) => entry.active)
      .map((entry) => ({ ...entry, applicationId: fields.applicationId }));
  });
  const scenarios = records.flatMap((record) =>
    record.fields.kind === "scenario"
      ? [{ id: record.id, featureId: record.fields.featureId }]
      : [],
  );
  const statusesById = productTaskStatuses(tasks, contracts, scenarios, completion);
  const readiness = records
    .filter((record) => record.fields.kind === "scenario" || record.fields.kind === "feature")
    .map((record) => {
      const selected = contracts.filter((contract) =>
        record.fields.kind === "scenario"
          ? contract.scenarioId === record.id
          : contract.featureId === record.id && contract.scenarioId === null,
      );
      return {
        id: record.id,
        status: statusesById.get(`${record.fields.kind}:${record.id}`) ?? "none",
        participants: selected.length,
        completed: selected.filter(
          (contract) => statusesById.get(`implementation:${contract.id}`) === "done",
        ).length,
        stale: 0,
      };
    });
  return {
    productId,
    version: productVersion(records),
    records: records.map(({ requests: _requests, events: _events, ...record }) => {
      if (record.fields.kind !== "scope") return record;
      return {
        ...record,
        fields: {
          ...record.fields,
          contracts: record.fields.contracts.map((contract) => ({
            ...contract,
            status: statusesById.get(`implementation:${contract.id}`) ?? "none",
          })),
        },
      };
    }),
    readiness,
  };
}
