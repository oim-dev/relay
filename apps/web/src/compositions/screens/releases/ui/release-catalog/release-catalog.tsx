import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Alert, Button, CloseButton, Skeleton, TextInput, VisuallyHidden } from "@mantine/core";
import { Plus, Search } from "lucide-react";
import { isDefined, isEmptyArray } from "shared/value-predicates";
import { useReleases, releaseStatusFromValue } from "domains/releases";
import { useProjectId } from "domains/project";
import { PageHeader } from "ui/page-header";
import { FilterChips } from "ui/filter-chips";
import { SectionPanel } from "ui/section-panel";
import { StatePanel } from "ui/state-panel";
import { useInputDraft } from "ui/input-draft";
import { ReleaseCard } from "./ui/release-card/release-card";
import type { ReleaseCatalogProps } from "./types/release-catalog-props.type";
import styles from "./styles/release-catalog.module.css";

/** Число карточек-заготовок при первом чтении каталога. */
const SKELETON_KEYS = ["first", "second", "third", "fourth"];

/**
 * Показывает будущие и состоявшиеся выпуски отдельно от планирования работ.
 *
 * Используется для:
 *  - выбора релиза по версии, статусу и готовности его состава
 */
export const ReleaseCatalog = (props: ReleaseCatalogProps) => {
  const { basePath, onCreate } = props;
  const projectId = useProjectId();
  const [searchParams, setSearchParams] = useSearchParams();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const query = searchParams.get("q") ?? "";
  // Поле поиска показывает локальный черновик, адрес синхронизирует его при Back/Forward.
  const [queryDraft, handleSearch] = useInputDraft(query, (value) => handleFilter("q", value));
  const status = releaseStatusFromValue(searchParams.get("status")) ?? "all";
  const limit = Math.max(12, Number(searchParams.get("limit")) || 12);
  const releasesQuery = useReleases(
    projectId,
    { q: query, ...(status === "all" ? {} : { status }) },
    limit,
  );
  const counts = releasesQuery.data?.statusCounts;
  const filterItems = [
    { value: "all", label: "Все", areaLabel: "Все релизы", count: counts?.all },
    {
      value: "planned",
      label: "Запланированные",
      areaLabel: "Запланированные релизы",
      count: counts?.planned,
    },
    {
      value: "released",
      label: "Выпущенные",
      areaLabel: "Выпущенные релизы",
      count: counts?.released,
    },
    {
      value: "cancelled",
      label: "Отменённые",
      areaLabel: "Отменённые релизы",
      count: counts?.cancelled,
    },
  ];
  const areaLabel =
    filterItems.find((filter) => filter.value === status)?.areaLabel ?? "Все релизы";
  const releaseItems = releasesQuery.data?.items ?? [];
  const total = releasesQuery.data?.total ?? 0;
  const hasData = isDefined(releasesQuery.data);
  const hasError = isDefined(releasesQuery.error);
  const isFirstLoading = !hasData && !hasError;
  const filterOptions = filterItems.map((filter) => ({
    ...filter,
    count: filter.count ?? (isFirstLoading ? "…" : undefined),
  }));
  const isEmpty = hasData && isEmptyArray(releaseItems);
  const hasFilters = query !== "" || status !== "all";
  const hasMore = isDefined(releasesQuery.data?.nextOffset);
  const resultLabel = isFirstLoading ? "…" : total;
  // Ошибка без прочитанного списка не даёт числа: ноль был бы ложным.
  const hasResultCount = hasData || isFirstLoading;
  const resultCount = hasResultCount ? (
    <span role="status">
      <VisuallyHidden>Найдено релизов: </VisuallyHidden>
      {resultLabel}
    </span>
  ) : undefined;
  const emptyTitle = hasFilters ? "Релизы не найдены" : "Запланируйте первый выпуск";
  const emptyDescription = hasFilters
    ? "Измените запрос или сбросьте условия поиска и статуса."
    : "Выберите планы работ, которые войдут в релиз. Они могут ещё выполняться.";
  const emptyAction = hasFilters ? "Сбросить условия" : "Создать релиз";

  useEffect(() => {
    document.title = "Релизы · Relay";
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  /**
   * Сохраняет поиск, статус и продолжение в URL каталога.
   */
  const handleFilter = (name: string, value: string) =>
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value === "" || value === "all") next.delete(name);
        else next.set(name, value);
        if (name !== "limit") next.delete("limit");
        return next;
      },
      { replace: name === "q" },
    );

  const clearButton = queryDraft !== "" && (
    <CloseButton size="sm" aria-label="Очистить поиск" onClick={() => handleSearch("")} />
  );

  return (
    <>
      <PageHeader
        title="Релизы"
        titleRef={headingRef}
        description="Соберите планы в выпуск и запланируйте его заранее. Статус выпуска и готовность его планов показаны отдельно."
        actionsLayout="toolbar"
        actions={
          <>
            <TextInput
              className={styles.search}
              type="search"
              size="md"
              aria-label="Поиск релизов"
              placeholder="Название, версия или ключ"
              leftSection={<Search size={17} aria-hidden="true" />}
              rightSection={clearButton}
              value={queryDraft}
              onChange={(event) => handleSearch(event.currentTarget.value)}
            />
            <Button
              size="md"
              className={styles.create}
              leftSection={<Plus size={17} aria-hidden="true" />}
              onClick={onCreate}
            >
              Создать релиз
            </Button>
          </>
        }
      />
      <SectionPanel title={areaLabel} density="compact" count={resultCount}>
        <FilterChips
          className={styles.filters}
          label="Статус релиза"
          options={filterOptions}
          value={status}
          onChange={(value) => handleFilter("status", value)}
        />
        {hasError && hasData && (
          <Alert color="warning" title="Не удалось обновить релизы">
            Показан последний прочитанный список. {releasesQuery.error?.message}
            <Button size="xs" variant="subtle" onClick={() => void releasesQuery.mutate()}>
              Повторить чтение
            </Button>
          </Alert>
        )}
        {hasError && !hasData && (
          <StatePanel
            state="error"
            title="Релизы не удалось прочитать"
            description={releasesQuery.error?.message ?? "Сервер не ответил на запрос каталога."}
            action={
              <Button variant="default" onClick={() => void releasesQuery.mutate()}>
                Повторить чтение
              </Button>
            }
          />
        )}
        {isFirstLoading && (
          <div className={styles.grid} role="status" aria-label="Загружаем релизы">
            {SKELETON_KEYS.map((key) => (
              <Skeleton key={key} height={248} radius="xl" />
            ))}
          </div>
        )}
        {isEmpty && (
          <StatePanel
            title={emptyTitle}
            description={emptyDescription}
            action={
              <Button
                variant="default"
                onClick={() => {
                  if (hasFilters) setSearchParams({});
                  else onCreate();
                }}
              >
                {emptyAction}
              </Button>
            }
          />
        )}
        {!isEmptyArray(releaseItems) && (
          <div className={styles.grid}>
            {releaseItems.map((release) => (
              <ReleaseCard key={release.id} release={release} basePath={basePath} />
            ))}
          </div>
        )}
        {hasMore && (
          <Button
            variant="default"
            className={styles.more}
            loading={releasesQuery.isValidating}
            onClick={() => handleFilter("limit", String(limit + 12))}
          >
            Показать ещё · {releaseItems.length} из {total}
          </Button>
        )}
      </SectionPanel>
    </>
  );
};
