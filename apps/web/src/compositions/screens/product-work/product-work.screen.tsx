import { Button, Text } from "@mantine/core";
import { Link, useLocation, useParams } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { useProductDemo } from "domains/product-demo";
import { getProductReturn, ProductPage, useProductPath } from "compositions/widgets/product-page";
import { PageStage } from "ui/page-stage";
import { MarkdownView } from "ui/markdown-view";
import { StatePanel } from "ui/state-panel";
import { StatusBadge } from "ui/status-badge";
import { isNonEmptyArray } from "shared/value-predicates";
import styles from "./styles/product-work.module.css";

/**
 * Раскрывает постановку и результаты связанной работы.
 *
 * Используется для:
 *  - просмотра планов, этапов и задач из продуктового контекста
 */
export const ProductWorkScreen = () => {
  const { workId } = useParams();
  const location = useLocation();
  const { snapshot } = useProductDemo();
  const base = useProductPath();
  const workData = snapshot.work.find((work) => work.id === workId);
  const backTo = getProductReturn(location.state, `${base}/passport`, base);
  if (workData === undefined)
    return (
      <PageStage>
        <StatePanel
          titleAs="h1"
          title="Работа не найдена"
          description="Выберите план или задачу из карточки фичи."
          action={
            <Button component={Link} to={`${base}/features`} variant="default">
              Открыть фичи
            </Button>
          }
        />
      </PageStage>
    );
  const kindLabel = { plan: "План", stage: "Этап", task: "Задача" }[workData.kind];
  const statusLabel = { done: "Завершено", active: "В работе", planned: "Запланировано" }[
    workData.status
  ];
  const statusTone = ({ done: "success", active: "info", planned: "neutral" } as const)[
    workData.status
  ];
  const parentData = snapshot.work.find((work) => work.id === workData.parentId);
  const hasParent = parentData !== undefined;
  const childItems = snapshot.work.filter((work) => work.parentId === workData.id);
  const hasChildren = isNonEmptyArray(childItems);
  const childLabel = workData.kind === "plan" ? "Этапы плана" : "Задачи этапа";
  const featureItems = snapshot.features.filter((feature) =>
    workData.featureIds.includes(feature.id),
  );
  const applicationItems = snapshot.applications.filter((application) =>
    workData.applicationIds.includes(application.id),
  );
  const returnTo = location.pathname;
  return (
    <ProductPage
      title={workData.name}
      description={workData.summary}
      meta={
        <>
          <span>{kindLabel}</span>
          <StatusBadge tone={statusTone}>{statusLabel}</StatusBadge>
        </>
      }
    >
      <div className={styles.root}>
        {hasParent && (
          <Link
            to={`${base}/work/${parentData.id}`}
            state={{ returnTo: backTo }}
            className={styles.parent}
          >
            В составе: {parentData.name}
            <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        )}
        <section className={styles.result}>
          <h2 className={styles.title}>Краткий результат</h2>
          <Text size="sm">{workData.result}</Text>
        </section>
        <article className={styles.document} aria-label="Подробности работы">
          <MarkdownView text={workData.description} />
        </article>
        {hasChildren && (
          <section>
            <h2 className={styles.title}>{childLabel}</h2>
            <ul className={styles.children}>
              {childItems.map((child) => (
                <li key={child.id} className={styles.child}>
                  <Link
                    to={`${base}/work/${child.id}`}
                    state={{ returnTo: backTo }}
                    className={styles.link}
                  >
                    {child.name}
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </Link>
                  <Text size="sm" c="dimmed" mt="xs">
                    {child.result}
                  </Text>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className={styles.context}>
          <h2 className={styles.title}>Контекст продукта</h2>
          <h3 className={styles.contextTitle}>Фичи</h3>
          <div className={styles.contextLinks}>
            {featureItems.map((feature) => (
              <Link
                key={feature.id}
                to={`${base}/features/${feature.id}`}
                state={{ returnTo }}
                className={styles.contextLink}
              >
                {feature.name}
              </Link>
            ))}
          </div>
          <h3 className={styles.contextTitle}>Приложения</h3>
          <div className={styles.contextLinks}>
            {applicationItems.map((application) => (
              <Link
                key={application.id}
                to={`${base}/applications/${application.id}`}
                state={{ returnTo }}
                className={styles.contextLink}
              >
                {application.name}
              </Link>
            ))}
          </div>
        </section>
        <Text size="xs" c="dimmed">
          Записи относятся к моковому продукту «Напрокат».
        </Text>
      </div>
    </ProductPage>
  );
};
