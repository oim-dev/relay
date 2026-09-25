import { useState } from "react";
import { Alert, Button, Group, Modal, TextInput, Textarea } from "@mantine/core";
import { useForm } from "@mantine/form";
import { z } from "zod";
import { readSessionValue, removeSessionStored, writeSessionStored } from "infra/browser-storage";
import { MarkdownField } from "ui/markdown-field";
import { isDefined } from "shared/value-predicates";
import type { StageFormProps } from "./types/stage-form-props.type";
import styles from "./styles/stage-form.module.css";

/**
 * Формулирует промежуточный результат этапа до выбора задач.
 *
 * Используется для:
 *  - создания и уточнения этапа с восстановимым черновиком
 */
export const StageForm = (props: StageFormProps) => {
  const { stage, revision, draftKey, isNew, onSave, onClose } = props;
  const [storedDraft] = useState(() => readSessionValue(draftKey));
  const [draft] = useState(() =>
    z
      .object({
        title: z.string(),
        summary: z.string(),
        revision: z.number().int().positive(),
        outcome: z.array(z.string()).transform((lines) => lines.join("\n")),
        completionConditions: z.array(z.string()).transform((lines) => lines.join("\n")),
      })
      .safeParse(storedDraft.value),
  );
  const invalidDraft =
    storedDraft.error ??
    (!draft.success && isDefined(storedDraft.value)
      ? "Черновик этапа имеет неизвестный формат. Отбросьте его явно."
      : null);
  const [error, setError] = useState<string | null>(invalidDraft);
  const [canPersist, setCanPersist] = useState(true);
  const form = useForm({
    mode: "uncontrolled",
    initialValues: draft.success
      ? draft.data
      : {
          title: stage.title,
          summary: stage.summary,
          outcome: stage.outcome,
          completionConditions: stage.completionConditions,
          revision,
        },
    validateInputOnBlur: true,
    validate: {
      title: (title) =>
        title.trim() === ""
          ? "Назовите промежуточный результат"
          : title.length > 160 || /[\r\n]/.test(title)
            ? "Название должно быть одной строкой до 160 символов"
            : null,
    },
    onValuesChange: (values) => {
      if (invalidDraft !== null) return;
      setCanPersist(
        writeSessionStored(draftKey, {
          ...values,
          outcome: values.outcome.split("\n"),
          completionConditions: values.completionConditions.split("\n"),
        }),
      );
    },
  });
  const title = isNew ? "Новый этап" : "Изменить этап";
  const buttonLabel = isNew ? "Добавить этап" : "Сохранить этап";
  const hasError = isDefined(error);

  /**
   * Сохраняет название и результат, не переписывая состав задач этапа.
   */
  const handleSubmit = async (values: typeof form.values) => {
    if (invalidDraft !== null) {
      setError(invalidDraft);
      return;
    }
    const outcome = await onSave(
      {
        ...stage,
        title: values.title.trim(),
        summary: values.summary,
        outcome: values.outcome,
        completionConditions: values.completionConditions,
      },
      values.revision,
    );
    if (outcome !== null) {
      setError(outcome);
      return;
    }
    removeSessionStored(draftKey);
    onClose();
  };

  return (
    <Modal
      attributes={{ header: { role: "presentation" } }}
      opened
      onClose={onClose}
      title={title}
      closeButtonProps={{ "aria-label": "Свернуть редактор этапа" }}
      size="lg"
    >
      <form
        className={styles.root}
        noValidate
        onSubmit={form.onSubmit(handleSubmit, () => form.getInputNode("title")?.focus())}
      >
        <p className={styles.hint}>
          Этап — законченный промежуточный результат. Задачи добавляются после создания.
        </p>
        <TextInput
          disabled={form.submitting}
          required
          label="Название этапа"
          placeholder="Например, проверка сквозного сценария"
          maxLength={160}
          data-autofocus
          key={form.key("title")}
          {...form.getInputProps("title")}
        />
        <Textarea
          label="Краткое описание"
          autosize
          minRows={2}
          disabled={form.submitting}
          key={form.key("summary")}
          {...form.getInputProps("summary")}
        />
        <MarkdownField
          label="Результат этапа"
          disabled={form.submitting}
          key={form.key("outcome")}
          {...form.getInputProps("outcome")}
        />
        <MarkdownField
          label="Условия завершения"
          disabled={form.submitting}
          key={form.key("completionConditions")}
          {...form.getInputProps("completionConditions")}
        />
        {!canPersist && (
          <Alert color="orange">
            Черновик не сохранился. Не закрывайте окно до сохранения этапа.
          </Alert>
        )}
        {hasError && (
          <Alert color="red">
            {error}
            <Button
              size="xs"
              variant="subtle"
              onClick={() => {
                removeSessionStored(draftKey);
                onClose();
              }}
            >
              Отбросить черновик и перечитать
            </Button>
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Свернуть
          </Button>
          <Button type="submit" loading={form.submitting}>
            {buttonLabel}
          </Button>
        </Group>
      </form>
    </Modal>
  );
};
