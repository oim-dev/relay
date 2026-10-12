import { Button } from "@mantine/core";
import { Network, Pencil } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ProductKey } from "domains/product";
import { useProjectBasePath } from "domains/project";
import { getFeatureStatus, ProductReadiness, useProductDemo } from "domains/product-demo";
import { ProductPage, useProductPath, useProductRoute } from "compositions/widgets/product-page";
import { ProductRequirement } from "compositions/widgets/product-requirement";
import { EntityDelete } from "compositions/widgets/entity-delete";
import { EntityDocuments } from "compositions/widgets/entity-documents";
import { PageStage } from "ui/page-stage";
import { StatePanel } from "ui/state-panel";
import { FeatureScenarios } from "./ui/feature-scenarios";
import styles from "./styles/product-feature.module.css";

/**
 * Представляет назначение фичи, вклад приложений и историю реализации.
 *
 * Используется для:
 *  - понимания полного пользовательского сценария без чтения логов
 */
export const ProductFeatureScreen = () => {
  const { featureId } = useProductRoute();
  const location = useLocation();
  const navigate = useNavigate();
  const { snapshot } = useProductDemo();
  const base = useProductPath();
  const projectBase = useProjectBasePath();
  const featureData = snapshot.features.find((feature) => feature.id === featureId);
  if (featureData === undefined)
    return (
      <PageStage>
        <StatePanel
          titleAs="h1"
          title="Фича не найдена"
          description="В выбранном наборе такой фичи нет: её удалили или адрес неверен."
          action={
            <Button component={Link} to={`${base}/features`} variant="default">
              К списку фич
            </Button>
          }
        />
      </PageStage>
    );
  return (
    <ProductPage
      title={featureData.name}
      description={featureData.summary}
      meta={
        <>
          <ProductKey value={featureData.key} copyable />
          <ProductReadiness status={getFeatureStatus(featureData)} />
        </>
      }
      actions={
        <>
          <Button
            component={Link}
            to={`${base}/features/${featureData.key ?? featureData.id}/edit${location.search}`}
            state={location.state}
            variant="default"
            leftSection={<Pencil size={15} aria-hidden="true" />}
          >
            Редактировать
          </Button>
          <Button
            component={Link}
            variant="subtle"
            to={`${projectBase}/relations?root=feature:${featureData.id}`}
            leftSection={<Network size={15} aria-hidden="true" />}
          >
            Все связи и контекст
          </Button>
          <EntityDelete
            key={featureData.id}
            kind="feature"
            entityId={featureData.id}
            onDeleted={() => navigate(`${base}/features`, { replace: true })}
          />
        </>
      }
    >
      <ProductRequirement
        key={featureData.id}
        kind="feature"
        targetId={featureData.id}
        description={featureData.description}
        parentName="Возможности продукта"
        parentHref={`${base}/features${location.search}`}
      >
        <FeatureScenarios key={`scenarios:${featureData.id}`} feature={featureData} />
      </ProductRequirement>
      <EntityDocuments
        className={styles.documents}
        target={{ kind: "feature", id: featureData.id }}
        targetTitle={featureData.name}
      />
    </ProductPage>
  );
};
