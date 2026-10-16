import clsx from "clsx";
import { Anchor, Button } from "@mantine/core";
import { Link } from "react-router-dom";
import { useProjectBasePath } from "domains/project";
import { ProductDependencies } from "compositions/widgets/product-dependencies";
import { ProductContributions } from "compositions/widgets/product-contributions";
import { ProductTasks } from "compositions/widgets/product-tasks";
import { MarkdownView } from "ui/markdown-view";
import { SectionPanel } from "ui/section-panel";
import type { ProductRequirementProps } from "./types/product-requirement-props.type";
import styles from "./styles/product-requirement.module.css";

/**
 * Представляет проектное требование в едином интерфейсе описания и выполнения.
 *
 * Используется для:
 *  - чтения фич и сценариев, их задач, зависимостей и реализаций приложений
 */
export const ProductRequirement = (props: ProductRequirementProps) => {
  const { targetId, kind, description, parentName, parentHref, children, className, ...rootAttrs } =
    props;
  const base = useProjectBasePath();
  const isFeature = kind === "feature";
  const descriptionLabel = isFeature ? "Описание фичи" : "Описание сценария";
  const parentLabel = isFeature ? "Раздел продукта" : "Родительская фича";
  const boardHref = `${base}/boards/product`;
  const reference = `${kind}:${targetId}`;
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <nav className={styles.navigation} aria-label="Разделы требования">
        <Anchor href="#requirement">Описание</Anchor>
        {isFeature && <Anchor href="#scenarios">Сценарии</Anchor>}
        <Anchor href="#requirement-tasks">Задачи реализации</Anchor>
        <Anchor href="#requirement-contributions">Приложения</Anchor>
        <Anchor href="#requirement-dependencies">Зависимости</Anchor>
      </nav>
      <div className={styles.content}>
        <SectionPanel
          id="requirement"
          tabIndex={-1}
          title={descriptionLabel}
          className={styles.anchor}
        >
          <div className={styles.document}>
            <MarkdownView text={description} />
          </div>
        </SectionPanel>
        {children}
        <ProductTasks
          key={`tasks:${targetId}`}
          id="requirement-tasks"
          tabIndex={-1}
          targetId={targetId}
          boardHref={boardHref}
          scope="product"
        />
      </div>
      <aside className={styles.sidebar} aria-label="Контекст требования">
        <SectionPanel title="Контекст требования" tone="feature">
          <dl className={styles.context}>
            <dt>{parentLabel}</dt>
            <dd>
              <Anchor component={Link} to={parentHref}>
                {parentName}
              </Anchor>
            </dd>
          </dl>
          <Button component={Link} to={boardHref} variant="default" fullWidth>
            Открыть продуктовую доску
          </Button>
        </SectionPanel>
        <ProductDependencies
          key={reference}
          id="requirement-dependencies"
          tabIndex={-1}
          reference={reference}
          title="Зависимости требования"
        />
        <ProductContributions
          key={targetId}
          id="requirement-contributions"
          tabIndex={-1}
          targetId={targetId}
        />
      </aside>
    </div>
  );
};
