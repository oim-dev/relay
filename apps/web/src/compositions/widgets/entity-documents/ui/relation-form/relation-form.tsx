import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import clsx from "clsx";
import { Button, Radio, Textarea } from "@mantine/core";
import { useForm } from "@mantine/form";
import { DOCUMENT_RELATION_TYPE_OPTIONS } from "domains/documents";
import { MarkdownView } from "ui/markdown-view";
import type { RelationFormProps, RelationFormValues } from "./types/relation-form-props.type";
import styles from "./styles/relation-form.module.css";

/** Предел пояснения связи из контракта. */
const DESCRIPTION_LIMIT = 16 * 1024;

/**
 * Изменяет тип и пояснение одной связи материала с сущностью.
 * Тип, уже занятый другой связью этой пары, недоступен. Escape закрывает форму без записи.
 *
 * Используется для:
 *  - правки связи в строке блока «Материалы»
 */
export const RelationForm = (props: RelationFormProps) => {
  const {
    type,
    description,
    takenTypes,
    isSubmitting,
    onSubmit,
    onCancel,
    className,
    ...rootAttrs
  } = props;
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const [openedDescription] = useState(description);
  const isChangedElsewhere = description !== openedDescription;
  const savedDescriptionText = description.trim() === "" ? "_пусто_" : description;
  const form = useForm<RelationFormValues>({
    mode: "controlled",
    initialValues: { type, description },
    validate: {
      description: (value) =>
        value.length > DESCRIPTION_LIMIT ? "Пояснение длиннее 16 384 символов" : null,
    },
  });
  useEffect(() => {
    const field = descriptionRef.current;
    if (field === null) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);
  const typeOptions = DOCUMENT_RELATION_TYPE_OPTIONS.map((option) => ({
    ...option,
    isTaken: takenTypes.includes(option.value),
    hint: takenTypes.includes(option.value) ? "уже есть у этой сущности" : undefined,
  }));
  /** Escape в поле закрывает форму, не закрывая родительский диалог. */
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape" || isSubmitting) return;
    event.stopPropagation();
    onCancel();
  };
  return (
    <form
      {...rootAttrs}
      className={clsx(styles.root, className)}
      aria-label="Изменение связи"
      onSubmit={form.onSubmit((values) => onSubmit(values))}
    >
      <Radio.Group label="Тип связи" size="xs" {...form.getInputProps("type")}>
        <div className={styles.types}>
          {typeOptions.map((option) => (
            <Radio
              key={option.value}
              value={option.value}
              label={option.label}
              description={option.hint}
              disabled={option.isTaken || isSubmitting}
              onKeyDown={handleKeyDown}
              data-mantine-stop-propagation
            />
          ))}
        </div>
      </Radio.Group>
      <Textarea
        ref={descriptionRef}
        label="Зачем нужен этот материал здесь"
        description="Необязательно. Markdown; пояснение относится только к этой связи."
        placeholder="Например: правила оформления, которые нужно соблюдать в этой задаче"
        autosize
        minRows={2}
        maxRows={8}
        size="xs"
        disabled={isSubmitting}
        onKeyDown={handleKeyDown}
        data-mantine-stop-propagation
        {...form.getInputProps("description")}
      />
      {isChangedElsewhere && (
        <div className={styles.changed} role="status">
          <p className={styles.changedTitle}>
            Пояснение изменилось в другом месте. Сейчас сохранено:
          </p>
          <MarkdownView text={savedDescriptionText} compact />
        </div>
      )}
      <div className={styles.actions}>
        <Button
          type="submit"
          size="xs"
          loading={isSubmitting}
          onKeyDown={handleKeyDown}
          data-mantine-stop-propagation
        >
          Сохранить
        </Button>
        <Button
          size="xs"
          variant="default"
          disabled={isSubmitting}
          onKeyDown={handleKeyDown}
          data-mantine-stop-propagation
          onClick={onCancel}
        >
          Отмена
        </Button>
      </div>
    </form>
  );
};
