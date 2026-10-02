import { useState } from "react";
import { TagsInput } from "@mantine/core";
import { isDefined } from "shared/value-predicates";
import { MATERIAL_TAG_LIMITS } from "../../config/documents.config";
import { normalizeMaterialTags } from "../../helpers/normalize-material-tags";
import { ALL_MATERIALS_FILTERS, useMaterialFacets } from "../../hooks/use-material-facets.hook";
import type { MaterialTagsInputProps } from "./types/material-tags-input-props.type";

/** Сравнение тегов без учёта регистра, как в Core. */
const toTagKey = (tag: string): string => tag.trim().toLocaleLowerCase("ru-RU");

/**
 * Позволяет выбрать существующие теги проекта или создать новый вводом (Enter или запятая).
 * Повторы без учёта регистра не добавляются, края обрезаются, лимиты контракта соблюдаются.
 *
 * Используется для:
 *  - фильтра каталога, редактора материала и массового добавления или снятия тегов
 */
export const MaterialTagsInput = (props: MaterialTagsInputProps) => {
  const { projectId, value, onChange, label, description, placeholder, error, disabled } = props;
  const { suggestions } = props;
  const [search, setSearch] = useState("");
  const facets = useMaterialFacets(
    projectId,
    isDefined(suggestions) ? null : ALL_MATERIALS_FILTERS,
  );
  const chosenKeys = new Set(value.map(toTagKey));
  const facetItems = facets.data?.tags ?? [];
  const optionItems = isDefined(suggestions)
    ? suggestions.map((tag) => ({ value: tag, label: tag }))
    : facetItems.map((entry) => ({ value: entry.tag, label: `${entry.tag} · ${entry.count}` }));
  const dataItems = optionItems.filter((option) => !chosenKeys.has(toTagKey(option.value)));
  const isTooLong = search.trim().length > MATERIAL_TAG_LIMITS.length;
  const searchError = isTooLong ? `Тег — не более ${MATERIAL_TAG_LIMITS.length} символов` : null;
  const fieldError = searchError ?? error;
  const knownKeys = new Set(optionItems.map((option) => toTagKey(option.value)));
  /** Оставляет только допустимые теги; при собственном наборе вариантов новые не создаются. */
  const handleChange = (next: string[]): void => {
    const allowed = isDefined(suggestions)
      ? next.filter((tag) => knownKeys.has(toTagKey(tag)))
      : next;
    onChange(normalizeMaterialTags(allowed));
  };
  return (
    <TagsInput
      label={label}
      description={description}
      placeholder={placeholder}
      error={fieldError}
      disabled={disabled}
      value={value}
      data={dataItems}
      searchValue={search}
      maxTags={MATERIAL_TAG_LIMITS.count}
      splitChars={[","]}
      acceptValueOnBlur
      clearable
      isDuplicate={(tag, current) => current.some((entry) => toTagKey(entry) === toTagKey(tag))}
      clearButtonProps={{ "aria-label": "Снять все теги" }}
      onSearchChange={setSearch}
      onChange={handleChange}
    />
  );
};
