import clsx from "clsx";
import { useState } from "react";
import { Alert, Button, Group, SegmentedControl, Text, Textarea } from "@mantine/core";
import { useForm } from "@mantine/form";
import {
  DOCUMENT_RELATION_TYPE_OPTIONS,
  DocumentAccessError,
  DocumentConflictError,
  DocumentRelationError,
} from "domains/documents";
import { EntityPicker } from "compositions/widgets/entity-picker";
import { isDefined } from "shared/value-predicates";
import { parseRelationTarget } from "../../helpers/parse-relation-target";
import type { RelationFormProps, RelationFormValues } from "./types/relation-form-props.type";
import styles from "./styles/relation-form.module.css";

/** Понятное объяснение ожидаемого отказа записи связи. */
const getFailureMessage = (failure: DocumentAccessError): string => {
  if (failure instanceof DocumentConflictError)
    return "Материал изменили, пока вы работали. Данные перечитаны, ваш ввод сохранён — проверьте связь и сохраните снова.";
  if (failure instanceof DocumentRelationError && failure.code === "ALREADY_EXISTS")
    return "Такая связь с этой сущностью уже есть. Выберите другой смысл связи или измените существующую.";
  if (failure instanceof DocumentRelationError)
    return "Этой связи больше нет: её уже сняли. Список связей обновлён.";
  return failure.message;
};

/**
 * Прикрепляет материал к сущности или меняет смысл и пояснение одной связи.
 * При отказе ввод остаётся в форме; повтор выполняет только человек.
 *
 * Используется для:
 *  - прикрепления материала к сущности любого из одиннадцати видов
 *  - изменения типа и пояснения существующей или прежней связи
 */
export const RelationForm = (props: RelationFormProps) => {
  const { entry, projectId, onSubmit, onCancel, className, ...rootAttrs } = props;
  const [error, setError] = useState("");
  const [defect, setDefect] = useState<Error>();
  const isEdit = isDefined(entry);
  const form = useForm<RelationFormValues>({
    mode: "uncontrolled",
    initialValues: {
      target: isEdit ? `${entry.relation.target.kind}:${entry.relation.target.id}` : null,
      type: entry?.relation.type ?? "references",
      description: entry?.relation.description ?? "",
    },
    validate: {
      target: (target) => {
        if (!isDefined(target) || target === "") return "Выберите сущность";
        return parseRelationTarget(target) === null
          ? "К этому виду записи материал прикрепить нельзя"
          : null;
      },
    },
  });
  const submitLabel = isEdit ? "Сохранить связь" : "Прикрепить";
  if (defect !== undefined) throw defect;
  /** Записывает связь и показывает отказ рядом с сохранённым вводом. */
  const handleSubmit = async (values: RelationFormValues): Promise<void> => {
    setError("");
    try {
      await onSubmit(values);
    } catch (failure) {
      if (failure instanceof DocumentAccessError) setError(getFailureMessage(failure));
      else setDefect(failure instanceof Error ? failure : new Error("Не удалось записать связь"));
    }
  };
  return (
    <form
      {...rootAttrs}
      className={clsx(styles.root, className)}
      noValidate
      onSubmit={(event) => {
        event.stopPropagation();
        form.onSubmit(handleSubmit)(event);
      }}
    >
      <fieldset className={styles.fields} disabled={form.submitting}>
        {isEdit && (
          <div className={styles.target}>
            <Text size="xs" c="dimmed">
              Сущность
            </Text>
            <Text fw={600} className={styles.targetTitle}>
              {entry.title}
            </Text>
            <Text size="xs" c="dimmed" ff="monospace">
              {entry.entityKey}
            </Text>
          </div>
        )}
        {!isEdit && (
          <EntityPicker
            projectId={projectId}
            label="Сущность"
            placeholder="Название или ключ…"
            required
            key={form.key("target")}
            {...form.getInputProps("target")}
          />
        )}
        {entry?.isLegacy === true && (
          <Alert color="gray" title="Прежняя связь области">
            Связь сохранена в старой форме. После сохранения она станет обычным прикреплением с
            выбранным смыслом и пояснением; сама сущность и материал не изменятся.
          </Alert>
        )}
        <div className={styles.field}>
          <Text size="sm" fw={500} id="relation-type-label">
            Смысл связи
          </Text>
          <SegmentedControl
            fullWidth
            aria-labelledby="relation-type-label"
            data={DOCUMENT_RELATION_TYPE_OPTIONS}
            key={form.key("type")}
            {...form.getInputProps("type")}
          />
          <Text size="xs" c="dimmed">
            «Для чтения» — полезный источник при работе. «Описывает сущность» — материал и есть её
            описание.
          </Text>
        </div>
        <Textarea
          label="Зачем нужен этот материал здесь"
          description="Необязательно · Markdown. Пояснение относится только к этой сущности."
          data-autofocus={isEdit || undefined}
          autosize
          minRows={3}
          maxRows={10}
          key={form.key("description")}
          {...form.getInputProps("description")}
        />
      </fieldset>
      {error !== "" && (
        <Alert color="orange" role="alert">
          {error}
        </Alert>
      )}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onCancel} disabled={form.submitting}>
          Отмена
        </Button>
        <Button type="submit" loading={form.submitting}>
          {submitLabel}
        </Button>
      </Group>
    </form>
  );
};
