import { Button, Skeleton } from "@mantine/core";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { useDocument, DOCUMENT_INPUT_SCHEMA } from "domains/documents";
import type { DocumentInput } from "domains/documents";
import { entityKindLabel, useEntitySummary } from "domains/entities";
import { useProjectBasePath, useProjectId } from "domains/project";
import { getProductReturn } from "compositions/widgets/product-page";
import { PageStage } from "ui/page-stage";
import { StatePanel } from "ui/state-panel";
import { isDefined } from "shared/value-predicates";
import { readEditorParams } from "./helpers/read-editor-params";
import { DocumentationForm } from "./ui/documentation-form";

/**
 * Открывает редактор материала: новый документ или внешнюю ссылку, в том числе
 * с начальным прикреплением к сущности, из которой начато создание.
 *
 * Используется для:
 *  - создания материала из библиотеки или блока «Материалы» сущности
 *  - изменения содержания, формата, адреса и свойств существующего материала
 */
export const ProductDocumentEditorScreen = () => {
  const { documentId } = useParams();
  const projectId = useProjectId();
  const base = useProjectBasePath();
  const location = useLocation();
  const [params] = useSearchParams();
  const isNew = documentId === undefined;
  const editorParams = readEditorParams(params, base);
  const query = useDocument(projectId, documentId ?? null);
  const target = useEntitySummary(projectId, isNew ? editorParams.attach : null);
  const catalogReturn = getProductReturn(location.state, `${base}/documents`, base);
  const isLoading = query.isLoading || target.isLoading;
  if (isLoading)
    return (
      <PageStage aria-busy="true">
        <Skeleton height={40} width="40%" />
        <Skeleton height={420} radius="xl" />
      </PageStage>
    );
  const loadError = isNew ? target.error : query.error;
  const errorTitle = isNew ? "Не найдена запись для прикрепления" : "Не удалось открыть редактор";
  const errorFallback = isNew
    ? "Сущность, к которой нужно прикрепить материал, недоступна."
    : "Материал не найден.";
  if ((!isNew && !isDefined(query.data)) || isDefined(target.error))
    return (
      <StatePanel
        title={errorTitle}
        description={loadError?.message ?? errorFallback}
        action={
          <Button component={Link} to={editorParams.returnTo ?? catalogReturn}>
            Назад
          </Button>
        }
      />
    );
  const attachment = isNew && isDefined(target.data) ? target.data : null;
  const initialData: DocumentInput = isDefined(query.data)
    ? { ...DOCUMENT_INPUT_SCHEMA.parse(query.data), url: query.data.url ?? "" }
    : {
        name: "",
        summary: "",
        body: "",
        documentKind: "description",
        documentStatus: "draft",
        sectionId: editorParams.section,
        pinned: false,
        documentFormat: "markdown",
        url: "",
        tags: [],
        relations: isDefined(attachment)
          ? [{ target: attachment.ref, type: editorParams.relation, description: "" }]
          : [],
      };
  const attachmentView = isDefined(attachment)
    ? {
        title: attachment.title,
        entityKey: attachment.key,
        kindLabel: entityKindLabel(attachment.ref.kind),
      }
    : null;
  const cardHref = isNew ? null : `${base}/documents/${documentId}`;
  const cancelTo = cardHref ?? editorParams.returnTo ?? catalogReturn;
  const title = isNew ? "Новый материал" : "Редактирование материала";
  const draftScope = `${projectId}:${documentId ?? `new:${editorParams.attach ?? "library"}`}`;
  return (
    <PageStage>
      <DocumentationForm
        key={draftScope}
        title={title}
        initial={initialData}
        documentId={documentId}
        revision={query.data?.revision ?? 0}
        draftScope={draftScope}
        attachment={attachmentView}
        cancelTo={cancelTo}
        createdReturnTo={editorParams.returnTo}
        catalogReturn={catalogReturn}
        onReload={() => void query.mutate()}
      />
    </PageStage>
  );
};
