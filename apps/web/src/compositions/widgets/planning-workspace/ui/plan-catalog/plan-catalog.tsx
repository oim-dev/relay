import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Alert, Button, TextInput } from "@mantine/core";
import { Flag, Plus, Search, X } from "lucide-react";
import { isDefined, isEmptyArray } from "shared/value-predicates";
import { usePlans, planStatusFromValue } from "domains/planning";
import { useProjectId } from "domains/project";
import { PlanCard } from "./ui/plan-card/plan-card";
import type { PlanCatalogProps } from "./types/plan-catalog-props.type";
import styles from "./styles/plan-catalog.module.css";

/**
 * Показывает планы с их состояниями и позволяет выбрать нужную работу.
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
  const description = "От намерения — к понятному следующему шагу.";
  const createLabel = "Новый план";
  const query = searchParams.get("q") ?? "";
  const state = planStatusFromValue(searchParams.get("status")) ?? "all";
  const limit = Math.max(12, Number(searchParams.get("limit")) || 12);
  const plansQuery = usePlans(
    projectId,
    { q: query, ...(state === "all" ? {} : { status: state }) },
    limit,
  );
  const counts = plansQuery.data?.statusCounts;
  const filterItems = [
    { value: "all", label: "Все", count: counts?.all ?? "…" },
    {
      value: "active",
      label: "В работе",
      count: counts?.active ?? "…",
    },
    {
      value: "draft",
      label: "Запланированы",
      count: counts?.draft ?? "…",
    },
    {
      value: "completed",
      label: "Завершённые",
      count: counts?.completed ?? "…",
    },
    {
      value: "cancelled",
      label: "Отменённые",
      count: counts?.cancelled ?? "…",
    },
  ];
  const planItems = plansQuery.data?.items ?? [];
  const total = plansQuery.data?.total ?? 0;
  const hasError = isDefined(plansQuery.error);
  const resultLabel = plansQuery.isLoading ? "Ищем…" : `Найдено: ${total}`;
  const hasFilters = query !== "" || state !== "all";
  const isEmpty = !plansQuery.isLoading && !hasError && isEmptyArray(planItems);
  const hasMore = isDefined(plansQuery.data?.nextOffset);
  const emptyTitle = hasFilters ? "Подходящих планов нет" : "Большие результаты начинаются с плана";
  const emptyDescription = hasFilters
    ? "Попробуйте другой запрос или сбросьте фильтры."
    : "Обозначьте цель, разбейте путь на этапы и выберите существующие задачи.";
  const emptyAction = hasFilters ? "Сбросить фильтры" : createLabel;

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

  return (
    <div className={styles.root}>
      <header className={styles.heading}>
        <div>
          <h1 className={styles.title} ref={headingRef} tabIndex={-1}>
            {title}
          </h1>
          <p className={styles.description}>{description}</p>
        </div>
        <Button leftSection={<Plus size={16} />} onClick={onCreate}>
          {createLabel}
        </Button>
      </header>

      <div className={styles.controls}>
        <div className={styles.filters} role="group" aria-label="Состояние плана">
          {filterItems.map((filter) => (
            <button
              key={filter.value}
              className={styles.filter}
              type="button"
              aria-pressed={state === filter.value}
              onClick={() => handleFilter("status", filter.value)}
            >
              {filter.label}
              <span className={styles.count}>{filter.count}</span>
            </button>
          ))}
        </div>
        <div className={styles.searchRow}>
          <TextInput
            className={styles.search}
            leftSection={<Search size={15} />}
            placeholder="Найти план по названию или ключу"
            aria-label="Поиск планов"
            value={query}
            onChange={(event) => handleFilter("q", event.currentTarget.value)}
            rightSection={
              query !== "" && (
                <button
                  type="button"
                  className={styles.clear}
                  aria-label="Очистить поиск"
                  onClick={() => handleFilter("q", "")}
                >
                  <X size={14} />
                </button>
              )
            }
          />
          <span className={styles.resultCount} role="status">
            {resultLabel}
          </span>
        </div>
      </div>

      {hasError && (
        <Alert color="red" title="Планы не удалось прочитать">
          {plansQuery.error?.message}
          <Button size="xs" variant="subtle" onClick={() => void plansQuery.mutate()}>
            Повторить
          </Button>
        </Alert>
      )}
      {plansQuery.isLoading && <p role="status">Загружаем планы…</p>}
      {isEmpty && (
        <div className={styles.empty}>
          <span className={styles.emptyIcon}>
            <Flag size={28} strokeWidth={1.4} />
          </span>
          <h2>{emptyTitle}</h2>
          <p>{emptyDescription}</p>
          <Button
            variant="default"
            onClick={() => {
              if (hasFilters) setSearchParams({});
              else onCreate();
            }}
          >
            {emptyAction}
          </Button>
        </div>
      )}

      <div className={styles.grid}>
        {planItems.map((plan) => (
          <PlanCard key={plan.id} plan={plan} basePath={basePath} />
        ))}
      </div>
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
      <footer className={styles.footer}>
        <Flag size={13} aria-hidden="true" />
        <span>План задаёт цель. Этапы делают путь обозримым. Задачи сохраняют свои доски.</span>
      </footer>
    </div>
  );
};
