import { Link, useLocation, useSearchParams } from "react-router-dom";
import { Button } from "@mantine/core";
import { findProductEntry, ProductKey } from "domains/product";
import { useProductDemo } from "domains/product-demo";
import {
  getProductReturn,
  ProductPage,
  useProductPath,
  useProductRoute,
} from "compositions/widgets/product-page";
import { PageStage } from "ui/page-stage";
import { StatePanel } from "ui/state-panel";
import { ApplicationScopeForm } from "./ui/application-scope-form";

/**
 * Связывает приложение с редактором его состава реализации.
 *
 * Используется для:
 *  - настройки выбранных фич, сценариев и описаний вклада в области приложения
 */
export const ProductApplicationScopeScreen = () => {
  const { applicationId } = useProductRoute();
  const { snapshot } = useProductDemo();
  const base = useProductPath();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const application = snapshot.applications.find((entry) => entry.id === applicationId);
  if (application === undefined)
    return (
      <PageStage>
        <StatePanel
          titleAs="h1"
          title="Приложение не найдено"
          description="Такого приложения нет в продукте. Откройте настройку из списка приложений."
          action={
            <Button component={Link} to={`${base}/applications`} variant="default">
              К приложениям
            </Button>
          }
        />
      </PageStage>
    );
  const backTo = getProductReturn(
    location.state,
    `${base}/applications/${application.id}#application-features`,
    base,
  );
  const contributions = snapshot.contributions.filter(
    (entry) => entry.applicationId === application.id,
  );
  const draftScope = `${snapshot.epoch}:application-scope:${application.id}`;
  return (
    <ProductPage
      title={`Реализация: ${application.name}`}
      description="Выберите фичи и сценарии, затем опишите, что приложение должно обеспечить в каждом из них."
      meta={
        <>
          <span>Состав приложения</span>
          <ProductKey value={application.key} copyable />
        </>
      }
    >
      <ApplicationScopeForm
        key={draftScope}
        application={application}
        features={snapshot.features}
        contributions={contributions}
        revision={snapshot.revision}
        draftScope={draftScope}
        backTo={backTo}
        initialFeatureId={
          findProductEntry(snapshot.features, searchParams.get("feature") ?? undefined)?.id
        }
        initialScenarioId={
          findProductEntry(
            snapshot.features.flatMap((entry) => entry.scenarios),
            searchParams.get("scenario") ?? undefined,
          )?.id
        }
      />
    </ProductPage>
  );
};
