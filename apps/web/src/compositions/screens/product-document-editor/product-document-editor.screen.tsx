import { Button, Skeleton } from "@mantine/core";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { useDocument, DOCUMENT_INPUT_SCHEMA } from "domains/documents";
import type { DocumentInput } from "domains/documents";
import { useEntitySummary } from "domains/entities";
import { useProjectBasePath, useProjectId } from "domains/project";
import { getProductReturn, ProductPage } from "compositions/widgets/product-page";
import { StatePanel } from "ui/state-panel";
import { DocumentationForm } from "./ui/documentation-form";

/**
 * Открывает полноценный документ с заранее выбранным контекстом создания.
 *
 * Используется для:
 *  - записи знаний и чернового проектирования из библиотеки или сущности
 */
export const ProductDocumentEditorScreen = () => {
  const { documentId } = useParams();
  const projectId = useProjectId();
  const base = useProjectBasePath();
  const location = useLocation();
  const [params] = useSearchParams();
  const query = useDocument(projectId, documentId ?? null);
  const target = useEntitySummary(projectId, documentId ? null : params.get("target"));
  const returnTo = getProductReturn(location.state, `${base}/documents`, base);
  const isNew = documentId === undefined;
  const isLoading = query.isLoading || target.isLoading;
  if (isLoading)
    return (
      <ProductPage title="Открываем редактор" description="Загружаем документ">
        <Skeleton height={350} />
      </ProductPage>
    );
  if ((!isNew && query.data === undefined) || (target.error && target.data === undefined))
    return (
      <StatePanel
        title="Не удалось открыть редактор"
        description={query.error?.message ?? target.error?.message ?? "Документ не найден."}
        action={
          <Button component={Link} to={returnTo}>
            Назад
          </Button>
        }
      />
    );
  const initialData: DocumentInput = query.data
    ? DOCUMENT_INPUT_SCHEMA.parse(query.data)
    : {
        name: "",
        summary: "",
        body: "",
        documentKind: "description",
        documentStatus: "draft",
        sectionId: params.get("section"),
        pinned: false,
        relations: target.data
          ? [{ target: target.data.ref, type: "references", description: "" }]
          : [],
      };
  const backTo = isNew ? returnTo : `${base}/documents/${documentId}`;
  const title = isNew ? "Новый документ" : "Редактирование документа";
  const draftScope = `${projectId}:${documentId ?? `new:${params.get("target") ?? "library"}`}`;
  return (
    <ProductPage
      title={title}
      description="Сохраните знание или начните проектировать решение. Связи помогут найти его в нужный момент."
    >
      <DocumentationForm
        key={draftScope}
        initial={initialData}
        documentId={documentId}
        revision={query.data?.revision ?? 0}
        draftScope={draftScope}
        backTo={backTo}
        returnTo={returnTo}
      />
    </ProductPage>
  );
};
