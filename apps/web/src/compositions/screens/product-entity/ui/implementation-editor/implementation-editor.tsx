import clsx from "clsx";
import { useRef, useState } from "react";
import { Alert, Button, Group, Text, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useBeforeUnload } from "react-router-dom";
import { z } from "zod";
import { productError, updateProductImplementation } from "domains/product";
import { readSessionStored, writeSessionStored, removeSessionStored } from "infra/browser-storage";
import { MarkdownField } from "ui/markdown-field";
import type { ImplementationEditorProps } from "./types/implementation-editor-props.type";
import styles from "./styles/implementation-editor.module.css";

/**
 * Редактирует отдельный вклад приложения с ID-черновиком и явным разрешением конфликта.
 *
 * Используется для:
 *  - сохранения описания без изменения соседних реализаций
 */
export const ImplementationEditor = (props: ImplementationEditorProps) => {
  const { projectId, initial, onSaved, onClose, className, ...rootAttrs } = props;
  const draftKey = `relay:implementation:${projectId}:${initial.id}`;
  const [draft] = useState(() =>
    z
      .object({
        revision: z.number(),
        title: z.string(),
        description: z.string(),
        status: z.enum(["none", "partial", "done"]),
      })
      .safeParse(readSessionStored(draftKey)),
  );
  const [revision, setRevision] = useState(draft.success ? draft.data.revision : initial.revision);
  const [error, setError] = useState("");
  const [canPersist, setCanPersist] = useState(true);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const form = useForm({
    mode: "uncontrolled",
    initialValues: draft.success ? draft.data : initial,
    onValuesChange: (values) =>
      setCanPersist(writeSessionStored(draftKey, { ...values, revision })),
    validate: {
      title: (value) =>
        value.trim() === "" || /[\r\n]/.test(value) ? "Введите однострочный заголовок" : null,
      description: (value) => (value.trim() === "" ? "Добавьте описание вклада" : null),
    },
  });
  const hasConflict = revision !== initial.revision;
  const canClose = canPersist || !form.isDirty();
  useBeforeUnload((event) => {
    if (canClose) return;
    event.preventDefault();
    event.returnValue = "";
  });
  const hasError = error !== "";
  /**
   * Сохраняет только содержание; готовность вычисляет сервер по задачам.
   */
  const handleSubmit = async (values: typeof form.values) => {
    setError("");
    const change = {
      ref: initial.id,
      ifRevision: revision,
      title: values.title,
      description: values.description,
    };
    const fingerprint = JSON.stringify(change);
    if (request.current?.fingerprint !== fingerprint)
      request.current = { fingerprint, id: crypto.randomUUID() };
    try {
      await updateProductImplementation(projectId, { ...change, requestId: request.current.id });
      removeSessionStored(draftKey);
      await onSaved();
    } catch (failure) {
      setError(productError(failure));
    }
  };
  /**
   * Явно заменяет черновик актуальным содержанием после конфликта.
   */
  const handleUseCurrent = () => {
    form.setValues(initial);
    form.resetDirty(initial);
    setRevision(initial.revision);
    setError("");
    removeSessionStored(draftKey);
  };
  /**
   * Сохраняет введённый текст и обновляет только основание следующей записи.
   */
  const handleKeepDraft = () => {
    setRevision(initial.revision);
    setCanPersist(
      writeSessionStored(draftKey, { ...form.getValues(), revision: initial.revision }),
    );
    setError("");
  };
  return (
    <form
      {...rootAttrs}
      noValidate
      className={clsx(styles.root, className)}
      onSubmit={form.onSubmit(handleSubmit)}
    >
      {hasConflict && (
        <Alert color="warning" title="Реализация изменилась" role="alert">
          Ввод сохранён. Выберите основу для продолжения.
          <Group gap="xs" mt="sm">
            <Button variant="default" size="xs" onClick={handleKeepDraft}>
              Оставить мой ввод
            </Button>
            <Button variant="subtle" size="xs" onClick={handleUseCurrent}>
              Загрузить актуальное
            </Button>
          </Group>
        </Alert>
      )}
      {!canPersist && (
        <Alert color="warning" role="alert">
          Черновик не удалось сохранить в браузере. Не закрывайте страницу до сохранения.
        </Alert>
      )}
      <fieldset disabled={form.submitting} className={styles.fields}>
        <legend className={styles.legend}>Вклад приложения</legend>
        <TextInput
          label="Название вклада"
          required
          key={form.key("title")}
          {...form.getInputProps("title")}
        />
        <Text size="sm" c="dimmed">
          Готовность рассчитывается автоматически по задачам реализации.
        </Text>
        <MarkdownField
          label="Описание вклада"
          key={form.key("description")}
          {...form.getInputProps("description")}
        />
      </fieldset>
      {hasError && (
        <Alert color="danger" role="alert" title="Не удалось сохранить">
          {error}
        </Alert>
      )}
      <footer className={styles.footer}>
        <Text size="xs" c="dimmed">
          Черновик остаётся в этой вкладке
        </Text>
        <Group gap="xs">
          <Button variant="default" onClick={onClose} disabled={!canClose || form.submitting}>
            Закрыть редактор
          </Button>
          <Button type="submit" loading={form.submitting} disabled={hasConflict}>
            Сохранить вклад
          </Button>
        </Group>
      </footer>
    </form>
  );
};
