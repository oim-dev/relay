import { useState } from "react";
import { Alert, Button, Group, Modal, Stack, Textarea, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { MarkdownField } from "ui/markdown-field";
import { isDefined } from "shared/value-predicates";
import { clearPlanDraft, readPlanDraft, writePlanDraft } from "./helpers/plan-form-draft";
import type { PlanFormProps, PlanFormValues } from "./types/plan-form-props.type";
import styles from "./styles/plan-form.module.css";

/**
 * Помогает сформулировать цель, сохраняя подробности и незавершённый ввод.
 *
 * Используется для:
 *  - компактного создания плана работ
 *  - редактирования Markdown без потери черновика при закрытии
 */
export const PlanForm = (props: PlanFormProps) => {
  const { plan, isNew, projectId, onSave, onClose } = props;
  const draftKey = `relay:planning-form:server-v2:${projectId}:${isNew ? "new" : plan.id}`;
  const [initialDraft] = useState(() =>
    readPlanDraft(draftKey, {
      revision: plan.revision,
      title: plan.title,
      summary: plan.summary,
      goal: plan.goal,
    }),
  );
  const [draftError, setDraftError] = useState(initialDraft.error);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<PlanFormValues>({
    mode: "uncontrolled",
    initialValues: initialDraft.values,
    validateInputOnBlur: true,
    validate: {
      title: (title) =>
        title.trim() === ""
          ? "Назовите результат плана"
          : title.length > 160 || /[\r\n]/.test(title)
            ? "Не более 160 символов в одной строке"
            : null,
    },
    onValuesChange: (values) => {
      if (initialDraft.error !== null) return;
      setDraftError(writePlanDraft(draftKey, values));
      setError(null);
    },
  });
  const title = isNew ? "Новый план" : "Редактировать план";
  const submitLabel = isNew ? "Создать план" : "Сохранить изменения";
  const hasError = isDefined(error);
  const hasDraftError = isDefined(draftError);

  /**
   * Очищает ввод только после серверной квитанции; исходная ревизия принадлежит черновику.
   */
  const handleSubmit = async (values: PlanFormValues) => {
    if (initialDraft.error !== null) {
      setError("Сначала сбросьте повреждённый черновик.");
      return;
    }
    const outcome = await onSave({
      ...plan,
      revision: values.revision,
      title: values.title.trim(),
      summary: values.summary,
      goal: values.goal,
    });
    if (outcome !== null) {
      setError(outcome);
      return;
    }
    try {
      clearPlanDraft(draftKey);
    } catch {
      /* План уже сохранён; повторное открытие покажет оставшийся черновик. */
    }
    onClose();
  };

  /**
   * Передаёт фокус первому полю с ошибкой без очистки формы.
   */
  const handleValidationError = (errors: typeof form.errors) => {
    const path = Object.keys(errors)[0];
    if (isDefined(path)) form.getInputNode(path)?.focus();
  };

  return (
    <Modal
      attributes={{ header: { role: "presentation" } }}
      opened
      onClose={onClose}
      title={title}
      size="lg"
      closeButtonProps={{ "aria-label": "Свернуть редактор плана" }}
      classNames={{ title: styles.modalTitle, body: styles.modalBody }}
    >
      <form
        className={styles.root}
        noValidate
        onSubmit={form.onSubmit(handleSubmit, handleValidationError)}
      >
        {hasDraftError && (
          <Alert color="orange" title="Проверьте черновик">
            {draftError}
            <Button
              mt="sm"
              size="xs"
              variant="default"
              onClick={() => {
                try {
                  clearPlanDraft(draftKey);
                  onClose();
                } catch {
                  setDraftError("Хранилище недоступно. Повторите сброс позже.");
                }
              }}
            >
              Сбросить черновик и закрыть
            </Button>
          </Alert>
        )}
        <fieldset className={styles.fields} disabled={form.submitting}>
          <Stack gap="md">
            <TextInput
              label="Название"
              placeholder="Какой результат хотим получить?"
              required
              maxLength={160}
              data-autofocus
              key={form.key("title")}
              {...form.getInputProps("title")}
            />
            <Textarea
              label="Краткое описание"
              placeholder="Пара предложений, чтобы понять план в каталоге"
              autosize
              minRows={2}
              maxRows={4}
              key={form.key("summary")}
              {...form.getInputProps("summary")}
            />
            <MarkdownField
              label="Цель и ожидаемый результат"
              placeholder="Что изменится и как поймём, что достигли цели?"
              key={form.key("goal")}
              {...form.getInputProps("goal")}
            />
          </Stack>
        </fieldset>
        {hasError && (
          <Alert color="red" title="Не удалось сохранить">
            {error}
            <Button
              size="xs"
              variant="subtle"
              onClick={() => {
                clearPlanDraft(draftKey);
                onClose();
              }}
            >
              Отбросить черновик и перечитать
            </Button>
          </Alert>
        )}
        <footer className={styles.footer}>
          <span>Черновик остаётся в этой вкладке</span>
          <Group gap="xs">
            <Button variant="default" onClick={onClose}>
              Свернуть
            </Button>
            <Button type="submit" loading={form.submitting}>
              {submitLabel}
            </Button>
          </Group>
        </footer>
      </form>
    </Modal>
  );
};
