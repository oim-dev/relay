import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Alert, Button, CloseButton, Skeleton, TextInput, VisuallyHidden } from "@mantine/core";
import { Plus, Search } from "lucide-react";
import { isDefined, isEmptyArray } from "shared/value-predicates";
import { usePlans, planStatusFromValue } from "domains/planning";
import { useProjectId } from "domains/project";
import { PageHeader } from "ui/page-header";
import { FilterChips } from "ui/filter-chips";
import { SectionPanel } from "ui/section-panel";
import { StatePanel } from "ui/state-panel";
import { PlanCard } from "./ui/plan-card/plan-card";
import type { PlanCatalogProps } from "./types/plan-catalog-props.type";
import styles from "./styles/plan-catalog.module.css";

/** Число карточек-заготовок при первом чтении каталога. */
const SKELETON_KEYS = ["first", "second", "third", "fourth"];

/**
 * Показывает планы с их состояниями и позволяет выбрать нужную работу.
 * Поиск, состояние и показанный объём хранятся в адресе.
 *
 * Используется для:
 *  - поиска и фильтрации планов работ
 *  - открытия плана из общего списка
 */
export const PlanCatalog = (props: PlanCatalogProps) => {
  const { basePath, onCreate } = props;
  const projectId = useProjectId();
  const [searchParams, setSearchParams] = useSearchParams();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const title = "Планы";
  const createLabel = "Новый план";
  const query = searchParams.get("q") ?? "";
  /*
   * Поле поиска хранит ввод локально: адрес обновляется навигацией позже нажатий, и
   * управляемое из адреса поле теряло символы быстрого ввода. Адрес остаётся источником
   * для внешних изменений (Back/Forward, переход по ссылке), собственные записи пропускаются.
   */
  const [queryDraft, setQueryDraft] = useState(query);
  const writtenQueries = useRef<string[]>([]);
  useEffect(() => {
    const index = writtenQueries.current.indexOf(query);
    if (index >= 0) {
      writtenQueries.current = writtenQueries.current.slice(index + 1);
      return;
    }
    writtenQueries.current = [];
    setQueryDraft(query);
  }, [query]);
  const state = planStatusFromValue(searchParams.get("status")) ?? "all";
  const limit = Math.max(12, Number(searchParams.get("limit")) || 12);
  const plansQuery = usePlans(
    projectId,
    { q: query, ...(state === "all" ? {} : { status: state }) },
    limit,
  );
  const counts = plansQuery.data?.statusCounts;
  const filterItems = [
    { value: "all", label: "Все", areaLabel: "Все планы", count: counts?.all },
    { value: "active", label: "В работе", areaLabel: "Планы в работе", count: counts?.active },
    {
      value: "draft",
      label: "Запланированы",
      areaLabel: "Запланированные планы",
      count: counts?.draft,
    },
    {
      value: "completed",
      label: "Завершённые",
      areaLabel: "Завершённые планы",
      count: counts?.completed,
    },
    {
      value: "cancelled",
      label: "Отменённые",
      areaLabel: "Отменённые планы",
      count: counts?.cancelled,
    },
  ];
  const areaLabel = filterItems.find((filter) => filter.value === state)?.areaLabel ?? "Все планы";
  const planItems = plansQuery.data?.items ?? [];
  const total = plansQuery.data?.total ?? 0;
  const hasData = isDefined(plansQuery.data);
  const hasError = isDefined(plansQuery.error);
  const isFirstLoading = !hasData && !hasError;
  const filterOptions = filterItems.map((filter) => ({
    ...filter,
    count: filter.count ?? (isFirstLoading ? "…" : undefined),
  }));
  const resultLabel = isFirstLoading ? "…" : total;
  // Ошибка без прочитанного списка не даёт числа: ноль был бы ложным.
  const hasResultCount = hasData || isFirstLoading;
  const resultCount = hasResultCount ? (
    <span role="status">
      <VisuallyHidden>Найдено планов: </VisuallyHidden>
      {resultLabel}
    </span>
  ) : undefined;
  const hasFilters = query !== "" || state !== "all";
  const isEmpty = hasData && isEmptyArray(planItems);
  const hasMore = isDefined(plansQuery.data?.nextOffset);
  const emptyTitle = hasFilters ? "Подходящих планов нет" : "Большие результаты начинаются с плана";
  const emptyDescription = hasFilters
    ? "Попробуйте другой запрос или сбросьте условия поиска и состояния."
    : "Обозначьте цель, разбейте путь на этапы и выберите существующие задачи.";
  const emptyAction = hasFilters ? "Сбросить условия" : createLabel;

  useEffect(() => {
    document.title = `${title} · Relay`;
    headingRef.current?.focus({ preventScroll: true });
  }, [title]);

  /**
   * Сохраняет фильтры в адресе, начиная выдачу с первой порции.
   */
  const handleFilter = (name: string, nextValue: string) => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete("kind");
        if (nextValue === "" || nextValue === "all") next.delete(name);
        else next.set(name, nextValue);
        if (name !== "limit") next.delete("limit");
        return next;
      },
      { replace: name === "q" },
    );
  };
  /**
   * Сохраняет ввод поиска сразу в поле и затем в адресе.
   */
  const handleSearch = (value: string): void => {
    setQueryDraft(value);
    writtenQueries.current.push(value);
    handleFilter("q", value);
  };
  const clearButton = queryDraft !== "" && (
    <CloseButton size="sm" aria-label="Очистить поиск" onClick={() => handleSearch("")} />
  );

  return (
    <>
      <PageHeader
        title={title}
        titleRef={headingRef}
        description="План задаёт цель, этапы делают путь обозримым, а задачи остаются на своих досках."
        actionsLayout="toolbar"
        actions={
          <>
            <TextInput
              className={styles.search}
              type="search"
              size="md"
              placeholder="Найти план по названию или ключу"
              aria-label="Поиск планов"
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
              {createLabel}
            </Button>
          </>
        }
      />

      <SectionPanel title={areaLabel} density="compact" count={resultCount}>
        <FilterChips
          className={styles.filters}
          label="Состояние плана"
          options={filterOptions}
          value={state}
          onChange={(value) => handleFilter("status", value)}
        />

        {hasError && hasData && (
          <Alert color="warning" title="Не удалось обновить планы">
            Показан последний прочитанный список. {plansQuery.error?.message}
            <Button size="xs" variant="subtle" onClick={() => void plansQuery.mutate()}>
              Повторить чтение
            </Button>
          </Alert>
        )}
        {hasError && !hasData && (
          <StatePanel
            state="error"
            title="Планы не удалось прочитать"
            description={plansQuery.error?.message ?? "Сервер не ответил на запрос каталога."}
            action={
              <Button variant="default" onClick={() => void plansQuery.mutate()}>
                Повторить чтение
              </Button>
            }
          />
        )}
        {isFirstLoading && (
          <div className={styles.grid} role="status" aria-label="Загружаем планы">
            {SKELETON_KEYS.map((key) => (
              <Skeleton key={key} height={232} radius="xl" />
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

        {!isEmptyArray(planItems) && (
          <div className={styles.grid}>
            {planItems.map((plan) => (
              <PlanCard key={plan.id} plan={plan} basePath={basePath} />
            ))}
          </div>
        )}
        {hasMore && (
          <Button
            variant="default"
            className={styles.more}
            loading={plansQuery.isValidating}
            onClick={() => handleFilter("limit", String(limit + 12))}
          >
            Показать ещё · {planItems.length} из {total}
          </Button>
        )}
      </SectionPanel>
    </>
  );
};
