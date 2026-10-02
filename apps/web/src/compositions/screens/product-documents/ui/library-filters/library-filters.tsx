import clsx from "clsx";
import { Select } from "@mantine/core";
import {
  DOCUMENT_KIND_OPTIONS,
  DOCUMENT_STATUSES,
  MATERIAL_FORMAT_OPTIONS,
  MaterialTagsInput,
} from "domains/documents";
import { EntityPicker } from "compositions/widgets/entity-picker";
import type { LibraryFiltersProps } from "./types/library-filters-props.type";
import styles from "./styles/library-filters.module.css";

/** Подпись варианта с серверным счётчиком. */
const withCount = (label: string, count: number | undefined): string =>
  count === undefined ? label : `${label} · ${count}`;

/**
 * Уточняет выдачу каталога условиями, которые сервер применяет ко всей библиотеке.
 * Числа у вариантов — сколько материалов останется при выборе варианта.
 *
 * Используется для:
 *  - фильтров над выдачей на широком экране и в выдвижной панели на телефоне
 */
export const LibraryFilters = (props: LibraryFiltersProps) => {
  const {
    projectId,
    facets,
    kind,
    format,
    status,
    isStatusFixed,
    tags,
    target,
    onChange,
    onTagsChange,
    className,
    ...rootAttrs
  } = props;
  const kindCounts = new Map(facets?.kinds.map((entry) => [entry.kind, entry.count]));
  const formatCounts = new Map(facets?.formats.map((entry) => [entry.format, entry.count]));
  const statusCounts = new Map(facets?.statuses.map((entry) => [entry.status, entry.count]));
  const kindOptions = DOCUMENT_KIND_OPTIONS.map((option) => ({
    value: option.value,
    label: withCount(option.label, kindCounts.get(option.value)),
  }));
  const formatOptions = MATERIAL_FORMAT_OPTIONS.map((option) => ({
    value: option.value,
    label: withCount(option.label, formatCounts.get(option.value)),
  }));
  const statusOptions = (["active", "draft"] as const).map((value) => ({
    value,
    label: withCount(DOCUMENT_STATUSES[value], statusCounts.get(value)),
  }));
  const tagSuggestions = facets?.tags.map((entry) => entry.tag) ?? [];
  const statusValue = isStatusFixed ? null : status;
  const statusPlaceholder = isStatusFixed ? "Задано представлением" : "Любое";
  return (
    <div
      {...rootAttrs}
      className={clsx(styles.root, className)}
      role="group"
      aria-label="Фильтры материалов"
    >
      <Select
        className={styles.field}
        label="Тип"
        placeholder="Все типы"
        clearable
        value={kind}
        data={kindOptions}
        onChange={(value) => onChange("kind", value)}
      />
      <Select
        className={styles.field}
        label="Формат"
        placeholder="Любой"
        clearable
        value={format}
        data={formatOptions}
        onChange={(value) => onChange("format", value)}
      />
      <Select
        className={styles.field}
        label="Состояние"
        placeholder={statusPlaceholder}
        clearable
        disabled={isStatusFixed}
        value={statusValue}
        data={statusOptions}
        onChange={(value) => onChange("status", value)}
      />
      <div className={styles.tags}>
        <MaterialTagsInput
          projectId={projectId}
          label="Теги"
          description="Все выбранные теги: материал должен иметь каждый из них"
          placeholder="Выберите тег"
          value={tags}
          suggestions={tagSuggestions}
          onChange={onTagsChange}
        />
      </div>
      <div className={styles.target}>
        <EntityPicker
          projectId={projectId}
          label="Прикреплён к"
          placeholder="Любая запись проекта"
          value={target}
          onChange={(value) => onChange("target", value)}
        />
      </div>
    </div>
  );
};
