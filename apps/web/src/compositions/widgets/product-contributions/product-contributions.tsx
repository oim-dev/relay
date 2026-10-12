import clsx from "clsx";
import { useState } from "react";
import { Alert, Button, Text } from "@mantine/core";
import { ArrowUpRight } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { ProductReadiness } from "domains/product-demo";
import { ProductKey, useProductEntities, productEntityPath } from "domains/product";
import { useEntities } from "domains/entities";
import { useProjectId } from "domains/project";
import { useProductPath } from "compositions/widgets/product-page";
import { SectionPanel } from "ui/section-panel";
import { isNonEmptyArray } from "shared/value-predicates";
import type { ProductContributionsProps } from "./types/product-contributions-props.type";
import styles from "./styles/product-contributions.module.css";

/**
 * Показывает активные реализации требования с независимой готовностью приложений.
 *
 * Используется для:
 *  - переходов от фичи или сценария к реализации, с постраничным чтением
 */
export const ProductContributions = (props: ProductContributionsProps) => {
  const { targetId, className, ...rootAttrs } = props;
  const project = useProjectId();
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState<string>();
  const query = useEntities(project, {
    kind: "implementation",
    target: targetId,
    active: "true",
    limit: 5,
    offset,
    version,
  });
  const refs = (query.data?.items ?? []).map((entry) => entry.ref.id);
  const metadata = useProductEntities(project, isNonEmptyArray(refs) ? { refs } : null);
  const location = useLocation();
  const base = useProductPath();
  const contributionItems = (query.data?.items ?? []).flatMap((entry) => {
    const meta = metadata.data?.items.find((item) => item.id === entry.ref.id);
    if (meta === undefined) return [];
    return [
      {
        id: meta.id,
        key: meta.key,
        title: meta.title,
        name: meta.applicationName ?? "Приложение",
        status: meta.status ?? "none",
        href: `${base}${productEntityPath(meta)}`,
      },
    ];
  });
  const hasError = query.error !== undefined || metadata.error !== undefined;
  const hasNoContributions = query.data?.total === 0 && !hasError;
  const isLoading = (query.isLoading || metadata.isLoading) && !hasError;
  const hasMore = query.data?.nextOffset !== null && query.data?.nextOffset !== undefined;
  const canGoBack = offset > 0;
  const returnTo = location.pathname + location.search + location.hash;
  /**
   * Перечитывает список и метаданные после сетевой ошибки или смены версии.
   */
  const handleRetry = (): void => {
    setOffset(0);
    setVersion(undefined);
    void query.mutate().catch(() => undefined);
    void metadata.mutate().catch(() => undefined);
  };
  return (
    <SectionPanel
      {...rootAttrs}
      className={clsx(styles.root, className)}
      title="Реализации в приложениях"
      description="Вклад каждого приложения и готовность по его задачам."
    >
      {hasNoContributions && (
        <Text size="sm" c="dimmed">
          Участие пока не объявлено. Выберите это требование в составе нужного приложения.
        </Text>
      )}
      {isLoading && (
        <Text size="sm" c="dimmed" role="status">
          Загружаем реализации…
        </Text>
      )}
      {hasError && (
        <Alert color="warning" title="Не удалось прочитать реализации">
          <Button variant="subtle" size="compact-sm" onClick={handleRetry}>
            Повторить
          </Button>
        </Alert>
      )}
      {isNonEmptyArray(contributionItems) && (
        <ul className={styles.list}>
          {contributionItems.map((contribution) => (
            <li key={contribution.id} className={styles.contribution}>
              <Link to={contribution.href} state={{ returnTo }} className={styles.link}>
                {contribution.name}
                <ArrowUpRight size={15} aria-hidden="true" />
              </Link>
              <div className={styles.meta}>
                <ProductKey value={contribution.key} />
                <ProductReadiness status={contribution.status} />
              </div>
              <p className={styles.description}>
                {contribution.title || "Заголовок вклада ещё не задан."}
              </p>
            </li>
          ))}
        </ul>
      )}
      {(hasMore || canGoBack) && (
        <div className={styles.pager}>
          {hasMore && (
            <Button
              size="compact-sm"
              variant="subtle"
              onClick={() => {
                setOffset(query.data?.nextOffset ?? 0);
                setVersion(query.data?.version);
              }}
            >
              Следующие реализации
            </Button>
          )}
          {canGoBack && (
            <Button size="compact-sm" variant="subtle" onClick={handleRetry}>
              В начало списка
            </Button>
          )}
        </div>
      )}
    </SectionPanel>
  );
};
