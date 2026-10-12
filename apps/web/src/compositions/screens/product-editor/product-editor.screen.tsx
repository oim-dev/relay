import { Button } from "@mantine/core";
import { Link, useLocation, useMatch } from "react-router-dom";
import { useProductDemo } from "domains/product-demo";
import {
  getProductReturn,
  ProductPage,
  useProductPath,
  useProductRoute,
} from "compositions/widgets/product-page";
import { PageStage } from "ui/page-stage";
import { StatePanel } from "ui/state-panel";
import { getEditorInput } from "./helpers/get-editor-input";
import { DocumentForm } from "./ui/document-form";

/**
 * Связывает адрес документа с редактором и областью черновика.
 *
 * Используется для:
 *  - создания и изменения паспорта, фич, их сценариев и приложений
 */
export const ProductEditorScreen = () => {
  const { collection, entityId, featureId, scenarioId } = useProductRoute();
  const location = useLocation();
  const creationMatch = useMatch("/projects/:project/product/:collection/new");
  const { snapshot } = useProductDemo();
  const base = useProductPath();
  const kind =
    featureId !== undefined
      ? "scenarios"
      : (collection ?? creationMatch?.params.collection ?? "passport");
  if (kind !== "passport" && kind !== "features" && kind !== "applications" && kind !== "scenarios")
    return (
      <PageStage>
        <StatePanel
          titleAs="h1"
          title="Редактор не найден"
          description="Откройте редактирование из нужного подраздела продукта."
        />
      </PageStage>
    );
  const initialData = getEditorInput(snapshot, kind, scenarioId ?? entityId ?? "", featureId);
  if (initialData === undefined)
    return (
      <PageStage>
        <StatePanel
          titleAs="h1"
          title="Запись не найдена"
          description="Редактируемой записи нет в продукте: её удалили или адрес неверен."
          action={
            <Button component={Link} to={`${base}/passport`} variant="default">
              К паспорту
            </Button>
          }
        />
      </PageStage>
    );
  const isNew = kind !== "passport" && initialData.id === "";
  const title =
    kind === "passport"
      ? "Редактирование паспорта"
      : isNew
        ? { features: "Новая фича", applications: "Новое приложение", scenarios: "Новый сценарий" }[
            kind
          ]
        : `Редактирование: ${initialData.name}`;
  const suffix = isNew ? "" : `/${initialData.id}`;
  const feature = snapshot.features.find((entry) => entry.id === featureId);
  const scenario = feature?.scenarios.find((entry) => entry.id === initialData.id);
  const featurePath = `${base}/features/${feature?.key ?? featureId}`;
  const fallback =
    kind === "scenarios"
      ? isNew
        ? `${featurePath}${location.search}#scenarios`
        : `${featurePath}/scenarios/${scenario?.key ?? initialData.id}${location.search}`
      : kind === "passport"
        ? `${base}/passport`
        : `${base}/${kind}${suffix}${location.search}`;
  const backTo = getProductReturn(location.state, fallback, base, "editorReturnTo");
  const draftEntity =
    kind === "scenarios" ? `${featureId}:${initialData.id || "new"}` : initialData.id || "new";
  const draftScope = `${snapshot.epoch}:${kind}:${draftEntity}`;
  const parentFeature = snapshot.features.find((feature) => feature.id === featureId);
  const description =
    kind === "scenarios"
      ? `Фича «${parentFeature?.name}». Опишите поведение и результат сценария. Его статус определяет готовность фичи.`
      : "Опишите смысл и ожидаемое поведение. Сохранённые изменения доступны всем участникам продукта.";
  return (
    <ProductPage title={title} description={description}>
      <DocumentForm
        key={draftScope}
        initial={initialData}
        revision={snapshot.revision}
        draftScope={draftScope}
        backTo={backTo}
      />
    </ProductPage>
  );
};
