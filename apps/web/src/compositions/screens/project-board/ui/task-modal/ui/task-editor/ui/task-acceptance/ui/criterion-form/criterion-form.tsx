import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Alert, Button, Group, Stack, Text, Textarea, TextInput, Title } from "@mantine/core";
import { useForm } from "@mantine/form";
import { BoardTaskError } from "domains/board-tasks";
import type { CriterionContent } from "domains/board-tasks";
import { writeSessionStored } from "infra/browser-storage";
import { MarkdownField } from "ui/markdown-field";
import { isDefined } from "shared/value-predicates";
import type { CriterionFormProps } from "./types/criterion-form-props.type";
import styles from "./styles/criterion-form.module.css";

/**
 * Сохраняет содержание критерия и устойчивый черновик.
 *
 * Используется для:
 *  - добавления и редактирования условий приёмки
 *  - сохранения ввода при сетевом отказе и конфликте ревизии
 */
export const CriterionForm = (props: CriterionFormProps) => {
  const {
    initialData,
    draftKey,
    currentRevision,
    isLocked,
    onSave,
    onClose,
    className,
    ...rootAttrs
  } = props;
  const [baseRevision, setBaseRevision] = useState(initialData.revision);
  const [error, setError] = useState("");
  const [defect, setDefect] = useState<unknown>();
  const [canPersist, setCanPersist] = useState(true);
  const requestRef = useRef(initialData.request);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  /**
   * Сохраняет текст и основание записи, не смешивая их с серверным кешем.
   */
  const persist = (values: CriterionContent, revision: number): void => {
    setCanPersist(
      writeSessionStored(draftKey, {
        ...initialData,
        values,
        revision,
        request: requestRef.current,
      }),
    );
  };
  const form = useForm<CriterionContent>({
    mode: "uncontrolled",
    initialValues: initialData.values,
    validateInputOnBlur: true,
    validate: {
      title: (value) =>
        value.trim() === "" || /[\p{Cc}\u2028\u2029]/u.test(value)
          ? "Введите однострочный заголовок"
          : new TextEncoder().encode(value).length > 1024
            ? "Заголовок превышает 1024 байта"
            : null,
      summary: (value) =>
        new TextEncoder().encode(value).length > 4096 ? "Краткое описание превышает 4 КиБ" : null,
      description: (value) =>
        new TextEncoder().encode(value).length > 65536 ? "Полное описание превышает 64 КиБ" : null,
    },
    onValuesChange: (values) => {
      persist(values, baseRevision);
      setError("");
    },
  });
  const hasConflict = currentRevision > baseRevision;
  const hasError = error !== "";
  const isDisabled = form.submitting || isLocked;
  const titleLabel =
    initialData.criterionId === null ? "Новый критерий" : "Редактирование критерия";
  /**
   * Сохраняет один критерий с исходной ревизией и корреляцией запроса.
   */
  const handleSubmit = async (values: CriterionContent): Promise<void> => {
    setError("");
    const fingerprint = JSON.stringify([initialData.criterionId, values, baseRevision]);
    if (requestRef.current?.fingerprint !== fingerprint)
      requestRef.current = { fingerprint, id: crypto.randomUUID() };
    persist(values, baseRevision);
    const writeData = { ...values, ifRevision: baseRevision, requestId: requestRef.current.id };
    try {
      if (initialData.criterionId === null) await onSave({ ...writeData, action: "add" });
      else await onSave({ ...writeData, action: "update", criterionId: initialData.criterionId });
      onClose();
    } catch (failure) {
      if (failure instanceof BoardTaskError) setError(failure.message);
      else setDefect(failure);
    }
  };
  /**
   * Явно применяет сохранённый ввод к свежей ревизии после сверки.
   */
  const handleRebase = (): void => {
    setBaseRevision(currentRevision);
    requestRef.current = undefined;
    persist(form.getValues(), currentRevision);
    setError("");
  };
  if (isDefined(defect)) throw defect;
  return (
    <form
      {...rootAttrs}
      className={clsx(styles.root, className)}
      noValidate
      onSubmit={form.onSubmit(handleSubmit, (errors) => {
        const field = Object.keys(errors)[0];
        if (isDefined(field)) form.getInputNode(field)?.focus();
      })}
    >
      <fieldset className={styles.fields} disabled={isDisabled}>
        <Stack gap="sm">
          <Title order={4} size="sm">
            {titleLabel}
          </Title>
          {hasConflict && (
            <Alert color="orange" title="Задача изменилась">
              Ввод сохранён. Сверьте критерий с актуальными данными перед сохранением.
              <Button size="xs" variant="light" mt="sm" onClick={handleRebase}>
                Применить ввод к новой ревизии
              </Button>
            </Alert>
          )}
          {!canPersist && (
            <Alert color="orange">
              Не удалось сохранить черновик в браузере. Сохраните критерий перед закрытием окна.
            </Alert>
          )}
          {initialData.wasCompleted && (
            <Text size="xs" c="dimmed">
              Изменение текста снимет отметку выполнения: критерий потребуется проверить повторно.
            </Text>
          )}
          <TextInput
            ref={titleRef}
            key={form.key("title")}
            label="Заголовок критерия"
            required
            {...form.getInputProps("title")}
          />
          <Textarea
            key={form.key("summary")}
            label="Краткое описание"
            autosize
            minRows={2}
            maxRows={5}
            {...form.getInputProps("summary")}
          />
          <MarkdownField
            key={form.key("description")}
            label="Полное описание"
            disabled={isDisabled}
            {...form.getInputProps("description")}
          />
          {hasError && (
            <Alert color="red" title="Критерий не сохранён" role="alert">
              {error}
            </Alert>
          )}
          <Group justify="space-between" gap="xs">
            <Text size="xs" c="dimmed">
              Черновик сохраняется в этой вкладке
            </Text>
            <Group gap="xs">
              <Button size="xs" variant="subtle" onClick={onClose}>
                Отменить
              </Button>
              <Button size="xs" type="submit" loading={form.submitting} disabled={hasConflict}>
                Сохранить критерий
              </Button>
            </Group>
          </Group>
        </Stack>
      </fieldset>
      {isLocked && (
        <Button size="xs" variant="subtle" mt="sm" onClick={onClose}>
          Отменить редактирование
        </Button>
      )}
    </form>
  );
};
