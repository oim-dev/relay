import { useState } from "react";
import {
  Alert,
  Button,
  Pagination,
  Select,
  Skeleton,
  TextInput,
  ThemeIcon,
  UnstyledButton,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { ChevronRight, Search } from "lucide-react";
import { useEntities } from "domains/entities";
import type { EntityKind } from "domains/entities";
import { relationAddress } from "domains/relations";
import { SectionPanel } from "ui/section-panel";
import { isEmptyArray } from "shared/value-predicates";
import {
  ENTITY_PRESENTATION,
  PAGE_CONTROL_LABELS,
  getEntityPresentation,
} from "../../config/relation-presentation";
import type { EntityBrowserProps } from "./types/entity-browser-props.type";
import styles from "./styles/entity-browser.module.css";

/**
 * Помогает найти отправную точку исследования связей.
 *
 * Используется для:
 *  - серверного поиска и постраничного выбора сущностей проекта
 */
export const EntityBrowser = ({ projectId, selected, onSelect }: EntityBrowserProps) => {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<EntityKind | undefined>();
  const [page, setPage] = useState({ offset: 0, version: undefined as string | undefined });
  const [debouncedSearch] = useDebouncedValue(search, 200);
  const query = useEntities(projectId, { q: debouncedSearch, kind, limit: 40, ...page });
  const entityItems = (query.data?.items ?? []).map((entity) => ({
    ...entity,
    address: relationAddress(entity.ref),
    presentation: getEntityPresentation(entity.ref.kind),
    isSelected: relationAddress(entity.ref) === selected,
  }));
  const kindItems = Object.entries(ENTITY_PRESENTATION).map(([value, entry]) => ({
    value,
    label: entry.label,
  }));
  const hasError = query.error !== undefined;
  const isEmpty = !query.isLoading && !hasError && isEmptyArray(entityItems);
  const total = query.data?.total ?? 0;
  const pageCount = Math.ceil(total / 40);
  const hasPages = pageCount > 1;
  const hasResults = !query.isLoading && !hasError;
  const hasEntities = !isEmptyArray(entityItems);
  /**
   * Меняет вид только на одно из известных значений каталога.
   */
  const handleKind = (value: string | null): void => {
    const nextKind = (Object.keys(ENTITY_PRESENTATION) as EntityKind[]).find(
      (entry) => entry === value,
    );
    setKind(nextKind);
    setPage({ offset: 0, version: undefined });
  };
  /**
   * Обновляет изменившийся снимок, сохраняя условия поиска.
   */
  const handleRefresh = (): void => {
    setPage({ offset: 0, version: undefined });
    void query.mutate().catch(() => undefined);
  };
  const countValue = hasResults ? total : undefined;
  return (
    <SectionPanel title="Сущности проекта" titleAs="h2" count={countValue} density="compact">
      <div className={styles.filters}>
        <TextInput
          aria-label="Найти сущность"
          placeholder="Название или ключ…"
          leftSection={<Search size={15} aria-hidden="true" />}
          value={search}
          onChange={(event) => {
            setSearch(event.currentTarget.value);
            setPage({ offset: 0, version: undefined });
          }}
        />
        <Select
          aria-label="Вид сущности"
          placeholder="Все виды сущностей"
          clearable
          data={kindItems}
          value={kind ?? null}
          onChange={handleKind}
        />
      </div>
      {query.isLoading && (
        <div className={styles.loading} role="status" aria-label="Загрузка каталога">
          <Skeleton h={48} />
          <Skeleton h={48} />
          <Skeleton h={48} />
        </div>
      )}
      {hasError && (
        <Alert color="danger" title="Каталог не загрузился">
          {query.error?.message}
          <Button variant="subtle" color="gray" mt="xs" onClick={handleRefresh}>
            Повторить
          </Button>
        </Alert>
      )}
      {isEmpty && (
        <p className={styles.empty} role="status">
          Ничего не найдено. Попробуйте другой ключ или вид сущности.
        </p>
      )}
      {hasEntities && (
        <ul className={styles.list}>
          {entityItems.map(({ address, key, title, presentation, isSelected }) => (
            <li key={address}>
              <UnstyledButton
                className={styles.entity}
                data-selected={isSelected}
                aria-current={isSelected}
                onClick={() => onSelect(address)}
              >
                <ThemeIcon color="accent" variant="light" size={30}>
                  <presentation.icon size={16} aria-hidden="true" />
                </ThemeIcon>
                <span className={styles.label}>
                  <span className={styles.meta}>
                    {key} · {presentation.label}
                  </span>
                  <span className={styles.title}>{title}</span>
                </span>
                <ChevronRight size={14} aria-hidden="true" className={styles.chevron} />
              </UnstyledButton>
            </li>
          ))}
        </ul>
      )}
      {hasPages && (
        <div className={styles.pages}>
          <p className={styles.range}>
            {page.offset + 1}–{Math.min(page.offset + 40, total)} из {total}
          </p>
          <Pagination
            autoContrast
            classNames={{ control: styles.pageControl }}
            size="sm"
            total={pageCount}
            value={page.offset / 40 + 1}
            siblings={0}
            boundaries={1}
            getItemProps={(number) => ({ "aria-label": `Страница каталога ${number}` })}
            getControlProps={(control) => ({
              "aria-label": `${PAGE_CONTROL_LABELS[control]} каталога`,
            })}
            onChange={(number) =>
              setPage({ offset: (number - 1) * 40, version: query.data?.version })
            }
          />
        </div>
      )}
    </SectionPanel>
  );
};
