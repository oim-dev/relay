import { useRef } from "react";
import { productError, saveProduct, useProduct, PRODUCT_LINK_SCHEMA } from "domains/product";
import type { ProductCommand, ProductInput, ProductLink } from "domains/product";
import { createProductView } from "../../helpers/create-product-view";
import { ProductDemoContext } from "./product-demo-context";
import type { ProductDocumentationInput } from "../../types/documentation.type";
import type {
  DemoMode,
  ProductDocumentInput,
  ProductContributionInput,
  ProductSaveResult,
} from "../../types/product-demo.type";
import type { ProductDemoProviderProps } from "./types/product-demo-provider-props.type";

/** Типы приложений постоянного контракта. */
const APPLICATION_TYPES = {
  Фронтенд: "frontend",
  Бэкенд: "backend",
  "Внутренний инструмент": "internal",
} as const;

/**
 * Подключает постоянный продукт к существующим экранам.
 *
 * Используется для:
 *  - проекции общих серверных данных и реальных связей
 *  - сохранения редакторов с исходной версией без автоматического повтора
 */
export const ProductDemoProvider = (props: ProductDemoProviderProps) => {
  const { scopeId, children } = props;
  const query = useProduct(scopeId);
  const requestsRef = useRef(new Map<string, string>());
  const state = query.data;
  const view = createProductView(
    state ?? { productId: scopeId, version: "0", records: [], readiness: [] },
  );
  const mode: DemoMode = query.error ? "read-error" : state === undefined ? "loading" : "filled";

  /**
   * Проверяет версию формы до отправки и сохраняет requestId при сетевом отказе.
   */
  const persist = async (
    fields: ProductInput,
    id: string,
    revision: number,
  ): Promise<ProductSaveResult> => {
    if (state === undefined || revision !== view.snapshot.revision)
      return {
        isSaved: false,
        message: "Продукт изменился после чтения. Сохраните ввод и загрузите актуальную версию.",
      };
    const previous = state.records.find((record) => record.id === id);
    if (id !== "" && previous === undefined)
      return { isSaved: false, message: "Редактируемая запись больше не существует." };
    const operation = {
      action: previous === undefined ? ("create" as const) : ("update" as const),
      ...(previous === undefined ? {} : { id: previous.id, ifRevision: previous.revision }),
      fields,
      ifVersion: state.version,
    };
    const fingerprint = JSON.stringify(operation);
    const requestId = requestsRef.current.get(fingerprint) ?? crypto.randomUUID();
    requestsRef.current.set(fingerprint, requestId);
    const command: ProductCommand = { ...operation, requestId };
    try {
      const saved = await saveProduct(scopeId, command);
      await query.mutate().catch(() => undefined);
      requestsRef.current.delete(fingerprint);
      return { isSaved: true, id: saved.id };
    } catch (error) {
      return { isSaved: false, message: productError(error) };
    }
  };

  /**
   * Сохраняет содержание без ручного статуса общего сценария.
   */
  const saveDocument = async (
    input: ProductDocumentInput,
    revision: number,
  ): Promise<ProductSaveResult> => {
    const common = { name: input.name, summary: input.summary, description: input.description };
    if (input.kind === "passport")
      return persist({ kind: "passport", ...common }, input.id, revision);
    if (input.kind === "features")
      return persist({ kind: "feature", ...common }, input.id, revision);
    if (input.kind === "scenarios")
      return persist(
        {
          kind: "scenario",
          featureId: input.featureId,
          name: input.name,
          description: input.description,
        },
        input.id,
        revision,
      );
    const type =
      Object.entries(APPLICATION_TYPES).find(([label]) => label === input.type)?.[1] ?? "frontend";
    return persist(
      {
        kind: "application",
        ...common,
        type,
        slug: input.slug,
        ...(input.prefix ? { prefix: input.prefix } : {}),
      },
      input.id,
      revision,
    );
  };

  /**
   * Сохраняет документ и независимые типизированные ссылки одной операцией.
   */
  const saveDocumentation = async (
    input: ProductDocumentationInput,
    revision: number,
  ): Promise<ProductSaveResult> => {
    let links: ProductLink[];
    try {
      links = input.scopeIds.map((id) => PRODUCT_LINK_SCHEMA.parse(JSON.parse(id)));
    } catch {
      return {
        isSaved: false,
        message: "Связи черновика устарели. Выберите области из текущего продукта.",
      };
    }
    return persist(
      {
        kind: "document",
        name: input.name,
        summary: input.summary,
        body: input.body,
        documentKind: input.kind,
        links,
      },
      input.id,
      revision,
    );
  };

  /**
   * Атомарно заменяет состав одного приложения; ядро сохраняет идентичность контрактов.
   */
  const saveApplicationScope = async (
    applicationId: string,
    contributions: ProductContributionInput[],
    revision: number,
  ): Promise<ProductSaveResult> => {
    const scope = state?.records.find(
      (record) => record.fields.kind === "scope" && record.fields.applicationId === applicationId,
    );
    const contracts = contributions.flatMap((entry) => [
      {
        featureId: entry.featureId,
        scenarioId: null,
        title: entry.title,
        description: entry.description,
        status: entry.status,
      },
      ...entry.scenarios.map((scenario) => ({
        featureId: entry.featureId,
        scenarioId: scenario.scenarioId,
        title: scenario.title,
        description: scenario.description,
        status: scenario.status,
      })),
    ]);
    return persist({ kind: "scope", applicationId, contracts }, scope?.id ?? "", revision);
  };

  /**
   * Повторяет реальное чтение после отказа.
   */
  const retry = (): void => {
    void query.mutate();
  };

  return (
    <ProductDemoContext
      value={{
        snapshot: view.snapshot,
        scopes: view.scopes,
        mode,
        notice: "",
        setMode: retry,
        reset: retry,
        saveDocument,
        saveDocumentation,
        saveApplicationScope,
      }}
    >
      {children}
    </ProductDemoContext>
  );
};
