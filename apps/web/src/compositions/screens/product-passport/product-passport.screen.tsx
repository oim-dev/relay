import { Button, Text } from "@mantine/core";
import { ArrowRight, Pencil, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { getFeatureStatus, useProductDemo } from "domains/product-demo";
import { EntityDocuments } from "compositions/widgets/entity-documents";
import { ProductPage, useProductPath } from "compositions/widgets/product-page";
import { MarkdownView } from "ui/markdown-view";
import { StatePanel } from "ui/state-panel";
import styles from "./styles/product-passport.module.css";

/**
 * Объясняет назначение продукта и открывает его карту реализации.
 *
 * Используется для:
 *  - знакомства с продуктом и редактирования нового паспорта
 */
export const ProductPassportScreen = () => {
  const { snapshot } = useProductDemo();
  const base = useProductPath();
  const passportData = snapshot.passport;
  const isEmpty = passportData.name === "";
  const doneCount = snapshot.features.filter(
    (feature) => getFeatureStatus(feature) === "done",
  ).length;
  const partialCount = snapshot.features.filter(
    (feature) => getFeatureStatus(feature) === "partial",
  ).length;
  const noneCount = snapshot.features.filter(
    (feature) => getFeatureStatus(feature) === "none",
  ).length;
  if (isEmpty)
    return (
      <ProductPage
        title="Паспорт продукта"
        description="Начните с общего понимания: что создаём, для кого и зачем."
      >
        <StatePanel
          title="У продукта пока нет паспорта"
          description="Опишите назначение, пользователей и границы. Затем добавьте фичи и приложения."
          action={
            <Button
              component={Link}
              to={`${base}/passport/edit`}
              leftSection={<Plus size={15} aria-hidden="true" />}
            >
              Заполнить паспорт
            </Button>
          }
        />
      </ProductPage>
    );
  return (
    <ProductPage
      title={passportData.name}
      description={passportData.summary}
      eyebrow="ПРОДУКТ / ПАСПОРТ"
      actions={
        <Button
          component={Link}
          to={`${base}/passport/edit`}
          variant="default"
          leftSection={<Pencil size={14} aria-hidden="true" />}
        >
          Редактировать
        </Button>
      }
    >
      <div className={styles.root}>
        <article className={styles.document} aria-label="Описание продукта">
          <MarkdownView text={passportData.description} />
        </article>
        <aside className={styles.aside} aria-label="Карта продукта">
          <section className={styles.panel}>
            <h2 className={styles.panelTitle}>Карта продукта</h2>
            <Text size="sm" c="dimmed" mb="lg">
              От замысла к работающему сценарию.
            </Text>
            <Link className={styles.stat} to={`${base}/features?status=done`}>
              <span className={styles.statLabel}>
                <span className={styles.dot} data-status="done" />
                Реализовано
              </span>
              <strong>{doneCount}</strong>
            </Link>
            <Link className={styles.stat} to={`${base}/features?status=partial`}>
              <span className={styles.statLabel}>
                <span className={styles.dot} data-status="partial" />
                Частично
              </span>
              <strong>{partialCount}</strong>
            </Link>
            <Link className={styles.stat} to={`${base}/features?status=none`}>
              <span className={styles.statLabel}>
                <span className={styles.dot} data-status="none" />
                Впереди
              </span>
              <strong>{noneCount}</strong>
            </Link>
            <Button
              component={Link}
              to={`${base}/features`}
              fullWidth
              variant="default"
              mt="lg"
              rightSection={<ArrowRight size={14} aria-hidden="true" />}
            >
              Все фичи · {snapshot.features.length}
            </Button>
            <Link to={`${base}/applications`} className={styles.appLink}>
              Приложения · {snapshot.applications.length}
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          </section>
          <Text size="xs" c="dimmed" lh={1.7}>
            Фича готова, когда готовы все её сценарии и общие контракты участвующих приложений.
          </Text>
        </aside>
      </div>
      <EntityDocuments
        className={styles.materials}
        target={{ kind: "product", id: "passport" }}
        targetTitle={passportData.name}
      />
    </ProductPage>
  );
};
