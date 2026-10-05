import clsx from "clsx";
import { Anchor, Button, Group, Stack, Text, ThemeIcon } from "@mantine/core";
import { BookOpen, Puzzle, Route } from "lucide-react";
import { Link } from "react-router-dom";
import { ProductKey } from "domains/product";
import { useProjectBasePath } from "domains/project";
import { ProductDependencies } from "compositions/widgets/product-dependencies";
import { ProductContributions } from "compositions/widgets/product-contributions";
import { ProductTasks } from "compositions/widgets/product-tasks";
import { MarkdownView } from "ui/markdown-view";
import type { ProductRequirementProps } from "./types/product-requirement-props.type";
import styles from "./styles/product-requirement.module.css";

/**
 * Представляет проектное требование в едином интерфейсе описания и выполнения.
 *
 * Используется для:
 *  - чтения фич и сценариев, их задач, зависимостей и реализаций приложений
 */
export const ProductRequirement = (props: ProductRequirementProps) => {
  const {
    targetId,
    kind,
    entityKey,
    description,
    parentName,
    parentHref,
    children,
    className,
    ...rootAttrs
  } = props;
  const base = useProjectBasePath();
  const isFeature = kind === "feature";
  const RequirementIcon = isFeature ? Puzzle : Route;
  const color = isFeature ? "violet" : "teal";
  const descriptionLabel = isFeature ? "Описание фичи" : "Описание сценария";
  const parentLabel = isFeature ? "Раздел продукта" : "Родительская фича";
  const boardHref = `${base}/boards/product`;
  const reference = `${kind}:${targetId}`;
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <nav className={styles.navigation} aria-label="Разделы требования">
        <Anchor href="#requirement" size="sm">
          Описание
        </Anchor>
        {isFeature && (
          <Anchor href="#scenarios" size="sm">
            Сценарии
          </Anchor>
        )}
        <Anchor href="#requirement-tasks" size="sm">
          Задачи реализации
        </Anchor>
        <Anchor href="#requirement-contributions" size="sm">
          Приложения
        </Anchor>
        <Anchor href="#requirement-dependencies" size="sm">
          Зависимости
        </Anchor>
      </nav>
      <div className={styles.content}>
        <section
          id="requirement"
          tabIndex={-1}
          className={styles.document}
          aria-label={descriptionLabel}
        >
          <Group gap="sm" mb="lg">
            <ThemeIcon color={color} variant="light" size="lg" radius="md">
              <RequirementIcon size={20} aria-hidden="true" />
            </ThemeIcon>
            <div>
              <Text component="h2" size="lg" fw={650}>
                {descriptionLabel}
              </Text>
              <ProductKey value={entityKey} />
            </div>
          </Group>
          <MarkdownView text={description} />
        </section>
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
        <section className={styles.context}>
          <Group gap="xs">
            <BookOpen size={17} aria-hidden="true" />
            <Text component="h2" size="sm" fw={650}>
              Контекст требования
            </Text>
          </Group>
          <Stack gap={4} mt="md">
            <Text size="xs" c="dimmed">
              {parentLabel}
            </Text>
            <Anchor component={Link} to={parentHref} size="sm">
              {parentName}
            </Anchor>
          </Stack>
          <Button component={Link} to={boardHref} variant="default" size="xs" mt="lg" fullWidth>
            Открыть продуктовую доску
          </Button>
        </section>
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
