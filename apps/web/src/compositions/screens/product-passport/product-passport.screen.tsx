import { Button, Text } from "@mantine/core";
import { ArrowRight, Pencil, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { getFeatureStatus, ProductReadiness, useProductDemo } from "domains/product-demo";
import { EntityDocuments } from "compositions/widgets/entity-documents";
import { ProductPage, useProductPath } from "compositions/widgets/product-page";
import { MarkdownView } from "ui/markdown-view";
import { SectionPanel } from "ui/section-panel";
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
  const countByStatus = (status: "done" | "partial" | "none"): number =>
    snapshot.features.filter((feature) => getFeatureStatus(feature) === status).length;
  const statItems = [
    { status: "done", label: "Реализовано", count: countByStatus("done") },
    { status: "partial", label: "Частично", count: countByStatus("partial") },
    { status: "none", label: "Впереди", count: countByStatus("none") },
  ] as const;
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
      meta="Паспорт продукта"
      actions={
        <Button
          component={Link}
          to={`${base}/passport/edit`}
          variant="default"
          leftSection={<Pencil size={15} aria-hidden="true" />}
        >
          Редактировать
        </Button>
      }
    >
      <div className={styles.layout}>
        <article className={styles.document} aria-label="Описание продукта">
          <MarkdownView text={passportData.description} />
        </article>
        <aside className={styles.aside} aria-label="Карта продукта">
          <SectionPanel
            title="Карта продукта"
            tone="feature"
            description="От замысла к работающему сценарию."
          >
            <ul className={styles.stats}>
              {statItems.map((item) => (
                <li key={item.status}>
                  <Link className={styles.stat} to={`${base}/features?status=${item.status}`}>
                    <ProductReadiness status={item.status} label={item.label} />
                    <strong className={styles.count}>{item.count}</strong>
                  </Link>
                </li>
              ))}
            </ul>
            <div className={styles.links}>
              <Button
                component={Link}
                to={`${base}/features`}
                fullWidth
                variant="default"
                rightSection={<ArrowRight size={15} aria-hidden="true" />}
              >
                Все фичи · {snapshot.features.length}
              </Button>
              <Button
                component={Link}
                to={`${base}/applications`}
                fullWidth
                variant="subtle"
                rightSection={<ArrowRight size={15} aria-hidden="true" />}
              >
                Приложения · {snapshot.applications.length}
              </Button>
            </div>
          </SectionPanel>
          <Text size="sm" c="dimmed" className={styles.note}>
            Фича готова, когда готовы все её сценарии и общие контракты участвующих приложений.
          </Text>
        </aside>
      </div>
      <EntityDocuments
        target={{ kind: "product", id: "passport" }}
        targetTitle={passportData.name}
      />
    </ProductPage>
  );
};
