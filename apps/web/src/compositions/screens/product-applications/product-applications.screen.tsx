import { Button, Text, VisuallyHidden } from "@mantine/core";
import { ArrowRight, AppWindow, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { useProductDemo } from "domains/product-demo";
import { ProductPage, useProductPath } from "compositions/widgets/product-page";
import { SectionPanel } from "ui/section-panel";
import { StatePanel } from "ui/state-panel";
import { isEmptyArray } from "shared/value-predicates";
import { ApplicationProgress } from "./ui/application-progress/application-progress";
import styles from "./styles/product-applications.module.css";

/**
 * Показывает части продукта и число связанных возможностей.
 *
 * Используется для:
 *  - выбора приложения по его назначению
 */
export const ProductApplicationsScreen = () => {
  const { snapshot } = useProductDemo();
  const base = useProductPath();
  const applicationItems = snapshot.applications.map((application) => {
    const contributions = snapshot.contributions.filter(
      (link) => link.applicationId === application.id,
    );
    return {
      ...application,
      featureCount: contributions.length,
      scenarioCount: contributions.reduce((count, link) => count + link.scenarios.length, 0),
      hasScope: !isEmptyArray(contributions),
    };
  });
  const hasNoApplications = isEmptyArray(applicationItems);
  return (
    <ProductPage
      title="Приложения"
      description="Каждое приложение выбирает свои фичи и сценарии и описывает, что берёт на себя."
      actions={
        <Button
          component={Link}
          to={`${base}/applications/new`}
          leftSection={<Plus size={15} aria-hidden="true" />}
        >
          Добавить приложение
        </Button>
      }
    >
      {hasNoApplications && (
        <StatePanel
          title="Приложений пока нет"
          description="Добавьте веб, API или другую часть продукта, затем выберите фичи и сценарии, которые оно реализует."
          action={
            <Button component={Link} to={`${base}/applications/new`} variant="default">
              Добавить первое приложение
            </Button>
          }
        />
      )}
      {!hasNoApplications && (
        <SectionPanel
          title="Части продукта"
          count={
            <>
              <VisuallyHidden>Приложений: </VisuallyHidden>
              {applicationItems.length}
            </>
          }
          description="Готовность считается по задачам на доске каждого приложения."
        >
          <ul className={styles.grid} aria-label="Приложения продукта">
            {applicationItems.map((application) => (
              <li key={application.id} className={styles.application}>
                <div className={styles.cardHeader}>
                  <span className={styles.icon} aria-hidden="true">
                    <AppWindow size={20} />
                  </span>
                  <span className={styles.type}>{application.type}</span>
                  <ArrowRight size={16} aria-hidden="true" className={styles.arrow} />
                </div>
                <h3 className={styles.name}>
                  <Link to={`${base}/applications/${application.id}`} className={styles.link}>
                    {application.name}
                  </Link>
                </h3>
                <Text size="sm" c="dimmed" className={styles.summary}>
                  {application.summary}
                </Text>
                <div className={styles.scope}>
                  <span>
                    Фичи: <strong>{application.featureCount}</strong>
                  </span>
                  <span>
                    Сценарии: <strong>{application.scenarioCount}</strong>
                  </span>
                </div>
                {!application.hasScope && (
                  <Text size="xs" c="dimmed">
                    Начните с выбора фич и сценариев
                  </Text>
                )}
                <ApplicationProgress board={application.slug} />
              </li>
            ))}
          </ul>
        </SectionPanel>
      )}
    </ProductPage>
  );
};
