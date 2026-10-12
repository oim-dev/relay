import clsx from "clsx";
import { Alert, Anchor, Button, Text } from "@mantine/core";
import { Link } from "react-router-dom";
import { useProductEntity, ProductKey, productError } from "domains/product";
import { useProjectId, useProjectBasePath } from "domains/project";
import { ProductTasks } from "compositions/widgets/product-tasks";
import { MarkdownView } from "ui/markdown-view";
import { SectionPanel } from "ui/section-panel";
import { ProductDependencies } from "compositions/widgets/product-dependencies";
import type { ImplementationDetailsProps } from "./types/implementation-details-props.type";
import styles from "./styles/implementation-details.module.css";

/**
 * Объединяет исходное требование, вклад приложения и подтверждающую работу.
 *
 * Используется для:
 *  - чтения полного описания и зависимостей реализации без скрытых разделов
 */
export const ImplementationDetails = (props: ImplementationDetailsProps) => {
  const {
    implementationId,
    targetId,
    title,
    description,
    applicationId,
    applicationName,
    applicationHref,
    sourceHref,
    className,
    ...rootAttrs
  } = props;
  const projectId = useProjectId();
  const projectBase = useProjectBasePath();
  const source = useProductEntity(projectId, targetId);
  const application = useProductEntity(projectId, applicationId);
  const applicationFields = application.data?.fields;
  const boardHref =
    applicationFields?.kind === "application"
      ? `${projectBase}/boards/${applicationFields.slug}`
      : undefined;
  const hasBoard = boardHref !== undefined;
  const sourceFields = source.data?.fields;
  const hasSource = sourceFields?.kind === "feature" || sourceFields?.kind === "scenario";
  const isScenario = sourceFields?.kind === "scenario";
  const sourceLabel = isScenario ? "Описание сценария" : "Описание фичи";
  const sourceDescription = hasSource ? sourceFields.description : "";
  const sourceTitle = hasSource ? sourceFields.name : "Исходное требование";
  const hasSourceError = source.error !== undefined;
  const isSourceLoading = !hasSource && !hasSourceError;
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <nav className={styles.navigation} aria-label="Разделы реализации">
        <Anchor href="#requirement">Описание</Anchor>
        <Anchor href="#contribution">Вклад приложения</Anchor>
        <Anchor href="#implementation-tasks">Задачи реализации</Anchor>
        <Anchor href="#implementation-dependencies">Зависимости</Anchor>
      </nav>
      <div className={styles.content}>
        <SectionPanel
          id="requirement"
          tabIndex={-1}
          className={styles.anchor}
          title={sourceLabel}
          actions={<ProductKey value={source.data?.key} />}
        >
          {isSourceLoading && (
            <Text role="status" size="sm" c="dimmed">
              Загружаем полное требование…
            </Text>
          )}
          {hasSourceError && (
            <Alert color="warning" title="Не удалось обновить требование">
              {productError(source.error)}{" "}
              <Button variant="subtle" size="compact-sm" onClick={() => void source.mutate()}>
                Повторить
              </Button>
            </Alert>
          )}
          {hasSource && (
            <div className={styles.document}>
              <MarkdownView text={sourceDescription} />
            </div>
          )}
        </SectionPanel>
        <SectionPanel
          id="contribution"
          tabIndex={-1}
          className={styles.anchor}
          title="Вклад приложения"
        >
          <div className={styles.document}>
            <p className={styles.lead}>{title}</p>
            <MarkdownView text={description} />
          </div>
        </SectionPanel>
        <ProductTasks
          id="implementation-tasks"
          tabIndex={-1}
          targetId={implementationId}
          boardHref={boardHref}
          scope="application"
        />
      </div>
      <aside
        id="implementation-dependencies"
        tabIndex={-1}
        className={clsx(styles.sidebar, styles.anchor)}
        aria-label="Контекст и зависимости"
      >
        <SectionPanel title="Контекст реализации" tone="feature">
          <dl className={styles.context}>
            <dt>Приложение</dt>
            <dd>
              <Anchor component={Link} to={applicationHref}>
                {applicationName}
              </Anchor>
            </dd>
            <dt>Исходное требование</dt>
            <dd>
              <Anchor component={Link} to={sourceHref ?? applicationHref}>
                {sourceTitle}
              </Anchor>
            </dd>
          </dl>
          {hasBoard && (
            <Button component={Link} to={boardHref} variant="default" fullWidth>
              Открыть доску приложения
            </Button>
          )}
        </SectionPanel>
        <ProductDependencies
          reference={`implementation:${implementationId}`}
          title="Зависимости реализации"
        />
        <ProductDependencies reference={targetId} title="Зависимости требования" />
      </aside>
    </div>
  );
};
