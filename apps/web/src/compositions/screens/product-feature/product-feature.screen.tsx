import { Button, Group, Text } from "@mantine/core";
import { Pencil } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ProductKey } from "domains/product";
import { useProjectBasePath } from "domains/project";
import { useProductRoute } from "compositions/widgets/product-page";
import { getFeatureStatus, ProductReadiness, useProductDemo } from "domains/product-demo";
import { getProductReturn, ProductPage, useProductPath } from "compositions/widgets/product-page";
import { ProductRequirement } from "compositions/widgets/product-requirement";
import { EntityDelete } from "compositions/widgets/entity-delete";
import { EntityDocuments } from "compositions/widgets/entity-documents";
import { StatePanel } from "ui/state-panel";
import { FeatureScenarios } from "./ui/feature-scenarios";

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
  const backTo = getProductReturn(location.state, `${base}/features${location.search}`, base);
  const backLabel = backTo.startsWith(`${base}/applications/`)
    ? "Назад к приложению"
    : backTo.startsWith(`${base}/work/`)
      ? "Назад к работе"
      : "К списку фич";
  if (featureData === undefined)
    return (
      <StatePanel
        title="Фича не найдена"
        description="В выбранном наборе такой фичи нет."
        action={
          <Button component={Link} to={`${base}/features`} variant="default">
            К списку фич
          </Button>
        }
      />
    );
  return (
    <ProductPage
      title={featureData.name}
      description={featureData.summary}
      eyebrow="ПРОДУКТ / ФИЧА"
      backTo={backTo}
      backLabel={backLabel}
      actions={
        <Group gap="xs">
          <Button
            component={Link}
            to={`${base}/features/${featureData.key ?? featureData.id}/edit${location.search}`}
            state={location.state}
            variant="default"
            leftSection={<Pencil size={14} aria-hidden="true" />}
          >
            Редактировать
          </Button>
          <EntityDelete
            key={featureData.id}
            kind="feature"
            entityId={featureData.id}
            onDeleted={() => navigate(`${base}/features`, { replace: true })}
          />
        </Group>
      }
      meta={
        <Group gap="md">
          <ProductKey value={featureData.key} copyable />
          <Button
            component={Link}
            variant="subtle"
            size="xs"
            to={`${projectBase}/relations?root=feature:${featureData.id}`}
          >
            Все связи и контекст
          </Button>
          <ProductReadiness status={getFeatureStatus(featureData)} />
          <Text size="xs" c="dimmed">
            Фича продукта · готовность по задачам и реализациям приложений
          </Text>
        </Group>
      }
    >
      <ProductRequirement
        key={featureData.id}
        kind="feature"
        targetId={featureData.id}
        entityKey={featureData.key}
        description={featureData.description}
        parentName="Возможности продукта"
        parentHref={`${base}/features${location.search}`}
      >
        <FeatureScenarios key={`scenarios:${featureData.id}`} feature={featureData} />
      </ProductRequirement>
      <div style={{ marginTop: "1.5rem" }}>
        <EntityDocuments
          target={{ kind: "feature", id: featureData.id }}
          targetTitle={featureData.name}
        />
      </div>
    </ProductPage>
  );
};
