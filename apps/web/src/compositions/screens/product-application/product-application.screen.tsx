import { Accordion, Button } from "@mantine/core";
import { Network, Pencil } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ProductKey } from "domains/product";
import { useProjectBasePath } from "domains/project";
import { useProductDemo } from "domains/product-demo";
import { ProductPage, useProductPath, useProductRoute } from "compositions/widgets/product-page";
import { MarkdownView } from "ui/markdown-view";
import { PageStage } from "ui/page-stage";
import { StatePanel } from "ui/state-panel";
import { EntityDelete } from "compositions/widgets/entity-delete";
import { EntityDocuments } from "compositions/widgets/entity-documents";
import { ApplicationFeatures } from "./ui/application-features";
import styles from "./styles/product-application.module.css";

/**
 * Объясняет ответственность приложения через описание и связанные фичи.
 *
 * Используется для:
 *  - переходов между вкладом приложения, фичами и задачами
 */
export const ProductApplicationScreen = () => {
  const { applicationId } = useProductRoute();
  const location = useLocation();
  const navigate = useNavigate();
  const { snapshot } = useProductDemo();
  const base = useProductPath();
  const projectBase = useProjectBasePath();
  const applicationData = snapshot.applications.find(
    (application) => application.id === applicationId,
  );
  const contributionItems = snapshot.contributions.filter(
    (link) => link.applicationId === applicationId,
  );
  const scenarioCount = contributionItems.reduce((count, link) => count + link.scenarios.length, 0);
  if (applicationData === undefined)
    return (
      <PageStage>
        <StatePanel
          titleAs="h1"
          title="Приложение не найдено"
          description="В выбранном наборе такого приложения нет: его удалили или адрес неверен."
          action={
            <Button component={Link} to={`${base}/applications`} variant="default">
              К приложениям
            </Button>
          }
        />
      </PageStage>
    );
  return (
    <ProductPage
      title={applicationData.name}
      description={applicationData.summary}
      meta={
        <>
          <ProductKey value={applicationData.key} copyable />
          <span className={styles.type}>{applicationData.type}</span>
          <span>
            Фичи: {contributionItems.length} · Сценарии: {scenarioCount}
          </span>
        </>
      }
      actions={
        <>
          <Button
            component={Link}
            to={`${base}/applications/${applicationData.key ?? applicationData.id}/edit`}
            state={location.state}
            variant="default"
            leftSection={<Pencil size={15} aria-hidden="true" />}
          >
            Редактировать приложение
          </Button>
          <Button
            component={Link}
            variant="subtle"
            to={`${projectBase}/relations?root=application:${applicationData.id}`}
            leftSection={<Network size={15} aria-hidden="true" />}
          >
            Все связи и контекст
          </Button>
          <EntityDelete
            key={applicationData.id}
            kind="application"
            entityId={applicationData.id}
            onDeleted={() => navigate(`${base}/applications`, { replace: true })}
          />
        </>
      }
    >
      <Accordion variant="separated" classNames={{ item: styles.about }}>
        <Accordion.Item value="about">
          <Accordion.Control>Назначение и границы приложения</Accordion.Control>
          <Accordion.Panel>
            <div className={styles.document}>
              <MarkdownView text={applicationData.description} />
            </div>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
      <ApplicationFeatures applicationId={applicationData.id} />
      <EntityDocuments
        target={{ kind: "application", id: applicationData.id }}
        targetTitle={applicationData.name}
      />
    </ProductPage>
  );
};
