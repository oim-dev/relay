import { useState } from "react";
import { Alert, Button, Checkbox, Select, Skeleton, TextInput } from "@mantine/core";
import { Search } from "lucide-react";
import {
  getPlanSummary,
  PLAN_STATUS_LABELS,
  PLAN_STATUS_TONES,
  usePlans,
  planStatusFromValue,
} from "domains/planning";
import { useProjectId } from "domains/project";
import { StatusBadge } from "ui/status-badge";
import { isDefined, isEmptyArray } from "shared/value-predicates";
import type { ReleasePlanPickerProps } from "./types/release-plan-picker-props.type";
import styles from "./styles/release-plan-picker.module.css";

/**
 * Выбирает планы в форме релиза и сохраняет выбор при поиске и смене страницы.
 *
 * Используется для:
 *  - комплектования будущего выпуска незавершёнными и готовыми планами
 */
export const ReleasePlanPicker = (props: ReleasePlanPickerProps) => {
  const { selectedIds, onChange, error } = props;
  const projectId = useProjectId();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [limit, setLimit] = useState(12);
  const selectedStatus = planStatusFromValue(status);
  const plansQuery = usePlans(
    projectId,
    { q: query, ...(selectedStatus === undefined ? {} : { status: selectedStatus }) },
    limit,
  );
  const planItems = (plansQuery.data?.items ?? []).map((plan) => ({
    ...plan,
    isSelected: selectedIds.includes(plan.id),
    isDisabled: plan.status === "cancelled" && !selectedIds.includes(plan.id),
    progress: getPlanSummary(plan),
  }));
  const hiddenCount = selectedIds.filter((id) => !planItems.some((plan) => plan.id === id)).length;
  const hasHidden = hiddenCount > 0;
  const hasReadError = isDefined(plansQuery.error);
  const isEmpty = !plansQuery.isLoading && !hasReadError && isEmptyArray(planItems);
  const hasMore = isDefined(plansQuery.data?.nextOffset);
  const total = plansQuery.data?.total ?? 0;
  const hasSelection = !isEmptyArray(selectedIds);
  const hasError = isDefined(error);

  /**
   * Меняет один элемент полного выбора без потери скрытых строк.
   */
  const handleSelect = (id: string, isSelected: boolean) =>
    onChange(isSelected ? [...selectedIds, id] : selectedIds.filter((selected) => selected !== id));

  return (
    <section className={styles.root} aria-label="Выбор планов для релиза">
      <div className={styles.heading}>
        <h3>
          Состав релиза <span aria-hidden="true">*</span>
        </h3>
        <span role="status">Выбрано: {selectedIds.length}</span>
      </div>
      <div className={styles.toolbar}>
        <TextInput
          id="release-plan-search"
          className={styles.search}
          aria-label="Поиск планов для релиза"
          placeholder="Название или ключ плана"
          leftSection={<Search size={16} aria-hidden="true" />}
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setLimit(12);
          }}
        />
        <Select
          className={styles.status}
          aria-label="Состояние выбираемых планов"
          allowDeselect={false}
          value={status}
          onChange={(next) => {
            setStatus(next ?? "all");
            setLimit(12);
          }}
          data={[
            { value: "all", label: "Все состояния" },
            { value: "active", label: "В работе" },
            { value: "completed", label: "Завершённые" },
            { value: "draft", label: "Запланированы" },
            { value: "cancelled", label: "Отменённые" },
          ]}
        />
      </div>
      {hasHidden && <p className={styles.hidden}>Вне текущего списка выбрано: {hiddenCount}</p>}
      {hasSelection && (
        <Button size="xs" variant="subtle" className={styles.clear} onClick={() => onChange([])}>
          Снять весь выбор
        </Button>
      )}
      {hasReadError && (
        <Alert color="danger" title="Планы не прочитаны">
          {plansQuery.error?.message}
          <Button size="xs" variant="subtle" onClick={() => void plansQuery.mutate()}>
            Повторить
          </Button>
        </Alert>
      )}
      <div className={styles.list}>
        {plansQuery.isLoading && (
          <div className={styles.loading} role="status" aria-label="Загружаем планы">
            <Skeleton height={44} />
            <Skeleton height={44} />
          </div>
        )}
        {planItems.map((plan) => (
          <div key={plan.id} className={styles.choice} data-selected={plan.isSelected}>
            <Checkbox
              className={styles.checkbox}
              label={plan.title}
              description={`${plan.key} · ${plan.progress.done} из ${plan.progress.total} задач`}
              checked={plan.isSelected}
              disabled={plan.isDisabled}
              onChange={(event) => handleSelect(plan.id, event.currentTarget.checked)}
            />
            <StatusBadge tone={PLAN_STATUS_TONES[plan.status]}>
              {PLAN_STATUS_LABELS[plan.status]}
            </StatusBadge>
          </div>
        ))}
        {isEmpty && (
          <p className={styles.empty}>
            Подходящих планов нет. Измените поиск или создайте план в разделе «Планы».
          </p>
        )}
        {hasMore && (
          <Button
            variant="subtle"
            fullWidth
            loading={plansQuery.isValidating}
            onClick={() => setLimit(limit + 12)}
          >
            Показать ещё · {planItems.length} из {total}
          </Button>
        )}
      </div>
      {hasError && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </section>
  );
};
