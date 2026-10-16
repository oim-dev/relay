import { useState } from "react";
import type { KeyboardEvent } from "react";
import { TagsInput } from "@mantine/core";
import { isDefined } from "shared/value-predicates";
import { MATERIAL_TAG_LIMITS } from "../../config/documents.config";
import { normalizeMaterialTags } from "../../helpers/normalize-material-tags";
import { ALL_MATERIALS_FILTERS, useMaterialFacets } from "../../hooks/use-material-facets.hook";
import type { MaterialTagsInputProps } from "./types/material-tags-input-props.type";
import styles from "./styles/material-tags-input.module.css";

/**
 * Прокручиваемый список не становится отдельной остановкой Tab: варианты выбираются
 * стрелками из поля, а Chrome иначе делает прокручиваемую область фокусируемой.
 */
const LIST_SCROLL_AREA_PROPS = { viewportProps: { tabIndex: -1 } };

/** Сравнение тегов без учёта регистра, как в Core. */
const toTagKey = (tag: string): string => tag.trim().toLocaleLowerCase("ru-RU");

/**
 * Позволяет выбрать существующие теги проекта или создать новый вводом (Enter или запятая).
 * Повторы без учёта регистра не добавляются, края обрезаются, лимиты контракта соблюдаются.
 *
 * Используется для:
 *  - фильтра каталога, редактора материала и массового добавления или снятия тегов
 *
 * В окне с действием под полем `inlineOptions` ставит список вариантов в поток формы,
 * чтобы он не перекрывал действие.
 */
export const MaterialTagsInput = (props: MaterialTagsInputProps) => {
  const { projectId, value, onChange, label, description, placeholder, error, disabled } = props;
  const { suggestions, inlineOptions = false, isDialogInitialFocus = false, ref } = props;
  const { onDraftValidityChange } = props;
  const [search, setSearch] = useState("");
  const [isUnknownDraftShown, setUnknownDraftShown] = useState(false);
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
  const knownKeys = new Set(optionItems.map((option) => toTagKey(option.value)));
  const draft = search.trim();
  const isTooLong = draft.length > MATERIAL_TAG_LIMITS.length;
  // При собственном наборе вариантов новый тег не создаётся: такой ввод не фиксируется.
  const isUnknownDraft = isDefined(suggestions) && draft !== "" && !knownKeys.has(toTagKey(draft));
  const isDraftInvalid = isTooLong || isUnknownDraft;
  const tooLongError = isTooLong ? `Тег — не более ${MATERIAL_TAG_LIMITS.length} символов` : null;
  const unknownError =
    isUnknownDraft && isUnknownDraftShown ? "Такого тега нет — выберите из списка" : null;
  const fieldError = tooLongError ?? unknownError ?? error;
  // Список в потоке закрывается уходом фокуса из поля, а не нажатием рядом: иначе он
  // схлопывается на mousedown и сдвигает следующее действие формы из-под указателя.
  const comboboxProps = inlineOptions
    ? { withinPortal: false, closeOnClickOutside: false }
    : undefined;
  const fieldClassNames = inlineOptions
    ? { dropdown: styles.inlineDropdown, option: styles.option }
    : { option: styles.option };
  const autofocusAttr = isDialogInitialFocus ? true : undefined;
  /** Оставляет только допустимые теги; при собственном наборе вариантов новые не создаются. */
  const handleChange = (next: string[]): void => {
    const allowed = isDefined(suggestions)
      ? next.filter((tag) => knownKeys.has(toTagKey(tag)))
      : next;
    onChange(normalizeMaterialTags(allowed));
  };
  /** Обновляет ввод и сообщает владельцу формы, можно ли его зафиксировать тегом. */
  const handleSearchChange = (next: string): void => {
    setSearch(next);
    setUnknownDraftShown(false);
    const nextDraft = next.trim();
    const isNextValid =
      nextDraft.length <= MATERIAL_TAG_LIMITS.length &&
      (!isDefined(suggestions) || nextDraft === "" || knownKeys.has(toTagKey(nextDraft)));
    onDraftValidityChange?.(isNextValid);
  };
  /**
   * Недопустимый ввод не превращается в тег ни по Enter или запятой, ни при уходе фокуса:
   * текст остаётся в поле вместе с объяснением, а не исчезает молча.
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (!isDraftInvalid || (event.key !== "Enter" && event.key !== ",")) return;
    // Выбор подсвеченного варианта списка Enter не блокирует.
    if (event.key === "Enter" && event.currentTarget.getAttribute("aria-activedescendant")) return;
    event.preventDefault();
    setUnknownDraftShown(true);
  };
  /** Показывает причину, по которой ввод не стал тегом. */
  const handleBlur = (): void => {
    if (isDraftInvalid) setUnknownDraftShown(true);
  };
  return (
    <TagsInput
      ref={ref}
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
      acceptValueOnBlur={!isDraftInvalid}
      clearable
      isDuplicate={(tag, current) => current.some((entry) => toTagKey(entry) === toTagKey(tag))}
      clearButtonProps={{ "aria-label": "Снять все теги" }}
      comboboxProps={comboboxProps}
      scrollAreaProps={LIST_SCROLL_AREA_PROPS}
      classNames={fieldClassNames}
      data-autofocus={autofocusAttr}
      onSearchChange={handleSearchChange}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      onChange={handleChange}
    />
  );
};
