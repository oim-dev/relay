import { useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Button } from "@mantine/core";
import { MaterialTagsInput } from "domains/documents";
import { isEmptyArray } from "shared/value-predicates";
import type { BulkTagsFormProps } from "./types/bulk-tags-form-props.type";
import styles from "./styles/bulk-tags-form.module.css";

/** Подписи режимов. */
const MODE_TEXT = {
  addTags: {
    label: "Добавить теги",
    hint: "Новый тег создаётся вводом и Enter",
    action: "Добавить выбранным",
    empty: "Введите или выберите хотя бы один тег",
  },
  removeTags: {
    label: "Снять теги",
    hint: "Теги выбранных материалов",
    action: "Снять у выбранных",
    empty: "Выберите хотя бы один тег для снятия",
  },
};

/**
 * Собирает набор тегов для одного массового действия и применяет его явной кнопкой.
 * Действие идёт после поля в порядке чтения и Tab; список вариантов стоит в потоке формы и
 * не перекрывает его, закрывается Tab или Escape. Кнопка доступна всегда: недописанный текст
 * становится тегом при уходе фокуса из поля, а пустой набор возвращает к полю с пояснением.
 *
 * Используется для:
 *  - добавления и снятия тегов у выбранных материалов в окне массовых действий
 */
export const BulkTagsForm = (props: BulkTagsFormProps) => {
  const { mode, projectId, selectedTags, onApply } = props;
  const [tags, setTags] = useState<string[]>([]);
  const [hasEmptyError, setEmptyError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Набор после фиксации недописанного ввода нужен в том же обработчике, до перерисовки.
  const tagsRef = useRef<string[]>([]);
  // Недопустимый ввод (длиннее лимита, вне набора) блокирует применение, а не теряется.
  const isDraftValidRef = useRef(true);
  const text = MODE_TEXT[mode];
  const suggestions = mode === "removeTags" ? selectedTags : undefined;
  const fieldError = hasEmptyError ? text.empty : undefined;
  /** Меняет набор и снимает пояснение о пустом наборе. */
  const handleChange = (next: string[]): void => {
    tagsRef.current = next;
    setTags(next);
    setEmptyError(false);
  };
  /**
   * Применяет набор; пустой набор или недопустимый ввод не отправляются, фокус возвращается
   * к полю. Уход фокуса из поля сначала превращает допустимый недописанный текст в тег.
   */
  const handleApply = (): void => {
    inputRef.current?.blur();
    if (!isDraftValidRef.current) {
      inputRef.current?.focus();
      return;
    }
    const next = tagsRef.current;
    if (!isEmptyArray(next)) {
      onApply(next);
      return;
    }
    setEmptyError(true);
    inputRef.current?.focus();
  };
  /** Запоминает, можно ли зафиксировать текущий ввод тегом. */
  const handleDraftValidityChange = (isValid: boolean): void => {
    isDraftValidRef.current = isValid;
  };
  /** Оставляет фокус в поле при нажатии кнопки мышью. */
  const preventFocusChange = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
  };
  return (
    <div className={styles.root}>
      <MaterialTagsInput
        ref={inputRef}
        projectId={projectId}
        label={text.label}
        description={text.hint}
        value={tags}
        suggestions={suggestions}
        error={fieldError}
        inlineOptions
        isDialogInitialFocus
        onDraftValidityChange={handleDraftValidityChange}
        onChange={handleChange}
      />
      <Button
        size="xs"
        // Нажатие мышью не уводит фокус из поля: открытый список не схлопывается под
        // указателем и не сдвигает кнопку до click; ввод фиксирует handleApply.
        onMouseDown={preventFocusChange}
        onClick={handleApply}
        className={styles.action}
      >
        {text.action}
      </Button>
    </div>
  );
};
