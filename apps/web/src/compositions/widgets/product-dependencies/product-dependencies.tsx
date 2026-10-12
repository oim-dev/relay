import clsx from "clsx";
import { useState } from "react";
import { Alert, Anchor, Button, Text } from "@mantine/core";
import { Link } from "react-router-dom";
import { useRelations, relationAddress } from "domains/relations";
import type { RelationsQuery } from "domains/relations";
import { useProjectId, useProjectBasePath } from "domains/project";
import { isEmptyArray } from "shared/value-predicates";
import { MarkdownView } from "ui/markdown-view";
import { RecordRow } from "ui/record-row";
import { SectionPanel } from "ui/section-panel";
import type { ProductDependenciesProps } from "./types/product-dependencies-props.type";
import styles from "./styles/product-dependencies.module.css";

/**
 * Показывает прямые зависимости с пояснением и ограниченным продолжением.
 *
 * Используется для:
 *  - чтения зависимостей реализации и её исходного требования
 */
export const ProductDependencies = (props: ProductDependenciesProps) => {
  const { reference, title, className, ...rootAttrs } = props;
  const project = useProjectId();
  const base = useProjectBasePath();
  const [page, setPage] = useState<Pick<RelationsQuery, "offset" | "version">>({ offset: 0 });
  const query = useRelations(project, {
    root: reference,
    type: "depends-on",
    direction: "outgoing",
    depth: 1,
    limit: 5,
    ...page,
  });
  const dependencyItems = (query.data?.edges ?? [])
    .filter((edge) => relationAddress(edge.from) === reference || edge.from.id === reference)
    .map((edge) => {
      const target = query.data?.endpoints.find(
        (node) => relationAddress(node.ref) === relationAddress(edge.to),
      );
      return {
        id: edge.id,
        title: target?.title ?? edge.to.id,
        key: target?.key ?? edge.to.id,
        href: `${base}/relations?root=${encodeURIComponent(relationAddress(edge.to))}`,
        description: edge.description,
        hasDescription: edge.description !== "",
      };
    });
  const isEmpty = query.data?.totalEdges === 0 && query.error === undefined;
  const hasError = query.error !== undefined;
  const isLoading = query.data === undefined && !hasError;
  const hasMore = query.data?.nextOffset !== null && query.data?.nextOffset !== undefined;
  const canGoBack = (page.offset ?? 0) > 0;
  const isPageEmpty = !isEmpty && isEmptyArray(dependencyItems) && !isLoading && !hasError;
  const contextHref = `${base}/relations?root=${encodeURIComponent(reference)}`;
  return (
    <SectionPanel {...rootAttrs} className={clsx(styles.root, className)} title={title}>
      {isLoading && (
        <Text size="sm" c="dimmed" role="status">
          Загружаем зависимости…
        </Text>
      )}
      {hasError && (
        <Alert color="warning" title="Не удалось прочитать зависимости">
          <Button
            size="compact-sm"
            variant="subtle"
            onClick={() => {
              setPage({ offset: 0 });
              void query.mutate();
            }}
          >
            Повторить
          </Button>
        </Alert>
      )}
      {isEmpty && (
        <Text size="sm" c="dimmed">
          Прямые зависимости не заданы.
        </Text>
      )}
      {isPageEmpty && (
        <Text size="sm" c="dimmed">
          На этой странице нет дополнительных зависимостей.
        </Text>
      )}
      {!isEmptyArray(dependencyItems) && (
        <ul className={styles.list}>
          {dependencyItems.map((entry) => (
            <RecordRow
              key={entry.id}
              component="li"
              code={entry.key}
              title={<Link to={entry.href}>{entry.title}</Link>}
              meta={entry.hasDescription && <MarkdownView text={entry.description} compact />}
            />
          ))}
        </ul>
      )}
      {(hasMore || canGoBack) && (
        <div className={styles.pager}>
          {hasMore && (
            <Button
              variant="subtle"
              size="compact-sm"
              onClick={() =>
                setPage({ offset: query.data?.nextOffset ?? 0, version: query.data?.version })
              }
            >
              Следующие зависимости
            </Button>
          )}
          {canGoBack && (
            <Button variant="subtle" size="compact-sm" onClick={() => setPage({ offset: 0 })}>
              В начало списка
            </Button>
          )}
        </div>
      )}
      <Anchor component={Link} to={contextHref} size="sm" className={styles.context}>
        Открыть все связи
      </Anchor>
    </SectionPanel>
  );
};
