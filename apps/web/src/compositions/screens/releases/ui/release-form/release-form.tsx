import { useState } from "react";
import { Accordion, Alert, Button, Group, Modal, Select, Textarea, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useReleasePreview, RELEASE_STATUS_OPTIONS } from "domains/releases";
import { MarkdownField } from "ui/markdown-field";
import { isDefined, isEmptyArray } from "shared/value-predicates";
import { ReleasePlanPicker } from "./ui/release-plan-picker";
import {
  readReleaseDraft,
  writeReleaseDraft,
  clearReleaseDraft,
} from "./helpers/release-form-draft";
import type { ReleaseFormProps, ReleaseFormValues } from "./types/release-form-props.type";
import styles from "./styles/release-form.module.css";

/**
 * Создаёт самостоятельный релиз сразу с выбранными планами и статусом.
 *
 * Используется для:
 *  - планирования будущего выпуска и изменения его состава
 *  - явной фиксации готового выпуска серверной операцией
 */
export const ReleaseForm = (props: ReleaseFormProps) => {
  const { release, projectId, isNew, onSave, onClose } = props;
  const scope = isNew ? "new" : release.id;
  const draftKey = `relay:release-form:server-v2:${projectId}:${scope}`;
  const [draft] = useState(() =>
    readReleaseDraft(draftKey, {
      revision: release.revision,
      title: release.title,
      version: release.version,
      summary: release.summary,
      description: release.description,
      plannedFor: release.plannedFor,
      status: release.status,
      planIds: [...release.planIds],
    }),
  );
  const [error, setError] = useState<string | null>(null);
  const [draftError, setDraftError] = useState(draft.error);
  const form = useForm<ReleaseFormValues>({
    mode: "uncontrolled",
    initialValues: draft.values,
    validateInputOnBlur: true,
    validate: {
      title: (title) =>
        title.trim() === ""
          ? "Введите название релиза"
          : title.length > 160 || /[\r\n]/.test(title)
            ? "Название — одна строка до 160 символов"
            : null,
      version: (version) =>
        version.trim() === "" ? "Укажите версию или обозначение выпуска" : null,
      planIds: (ids) =>
        isEmptyArray(ids)
          ? "Выберите хотя бы один план"
          : ids.length > 200
            ? "В одном релизе допускается до 200 планов"
            : null,
    },
    onValuesChange: (values) => {
      if (draft.error === null) setDraftError(writeReleaseDraft(draftKey, values));
      setError(null);
    },
  });
  const status = form.useWatchValue("status");
  const selectedIds = form.useWatchValue("planIds");
  const preview = useReleasePreview(projectId, selectedIds);
  const summary = preview.data?.readiness;
  const hasPreviewError = isDefined(preview.error);
  const readinessLabel = preview.isLoading
    ? "Проверяем готовность выбранных планов…"
    : isDefined(summary)
      ? `Готово планов: ${summary.ready} из ${summary.total}.`
      : "Готовность пока недоступна.";
  const isReleasing = status === "released";
  const canSubmit =
    !isReleasing || (summary?.canRelease === true && !hasPreviewError && !preview.isLoading);
  const hasError = isDefined(error);
  const hasDraftError = isDefined(draftError);
  const title = isNew ? "Создать релиз" : "Изменить релиз";
  const saveLabel = isReleasing
    ? "Зафиксировать выпуск"
    : isNew
      ? "Создать релиз"
      : "Сохранить релиз";

  /**
   * Сохраняет весь состав; не запускает и не завершает включённые планы.
   */
  const handleSubmit = async (values: ReleaseFormValues) => {
    if (draft.error !== null) {
      setError("Сначала сбросьте повреждённый черновик.");
      return;
    }
    const result = await onSave({ ...release, ...values });
    if (result !== null) {
      setError(result);
      return;
    }
    try {
      clearReleaseDraft(draftKey);
    } catch {
      /* Подтверждённый релиз уже сохранён. */
    }
    onClose();
  };

  /**
   * Фокусирует первое поле с ошибкой; состав имеет собственное поле поиска.
   */
  const handleValidationError = (errors: typeof form.errors) => {
    const first = Object.keys(errors)[0];
    if (first === "planIds") {
      document.getElementById("release-plan-search")?.focus();
      return;
    }
    if (isDefined(first)) form.getInputNode(first)?.focus();
  };

  return (
    <Modal
      opened
      onClose={onClose}
      title={title}
      size="xl"
      attributes={{ header: { role: "presentation" } }}
      closeButtonProps={{ "aria-label": "Свернуть редактор релиза" }}
      classNames={{ title: styles.modalTitle, body: styles.modalBody }}
    >
      <form
        className={styles.root}
        noValidate
        onSubmit={form.onSubmit(handleSubmit, handleValidationError)}
      >
        <p className={styles.intro}>
          Выберите, что войдёт в выпуск. Незавершённые планы можно включить заранее.
        </p>
        {hasDraftError && (
          <Alert color="orange" title="Черновик требует внимания">
            {draftError}
            <Button
              size="xs"
              variant="default"
              mt="sm"
              onClick={() => {
                try {
                  clearReleaseDraft(draftKey);
                  onClose();
                } catch {
                  setDraftError("Не удалось очистить черновик. Повторите действие позже.");
                }
              }}
            >
              Сбросить черновик и закрыть
            </Button>
          </Alert>
        )}
        <fieldset className={styles.fields} disabled={form.submitting}>
          <div className={styles.headingFields}>
            <TextInput
              label="Название релиза"
              required
              placeholder="Например, первый публичный выпуск"
              maxLength={160}
              data-autofocus
              key={form.key("title")}
              {...form.getInputProps("title")}
            />
            <TextInput
              label="Версия"
              required
              placeholder="0.1.0"
              maxLength={80}
              key={form.key("version")}
              {...form.getInputProps("version")}
            />
          </div>
          <div className={styles.row}>
            <Select
              label="Статус релиза"
              allowDeselect={false}
              data={RELEASE_STATUS_OPTIONS}
              key={form.key("status")}
              {...form.getInputProps("status")}
            />
            <TextInput
              label="Плановая дата"
              type="date"
              key={form.key("plannedFor")}
              {...form.getInputProps("plannedFor")}
            />
          </div>
          <Textarea
            label="Краткое описание"
            placeholder="Что получат пользователи в этом выпуске?"
            autosize
            minRows={2}
            maxRows={4}
            key={form.key("summary")}
            {...form.getInputProps("summary")}
          />
          <ReleasePlanPicker
            selectedIds={selectedIds}
            onChange={(ids) => form.setFieldValue("planIds", ids)}
            error={form.errors.planIds}
          />
          {isReleasing && (
            <Alert color="gray" title="Явная фиксация выпуска">
              {readinessLabel} При сохранении будут зафиксированы дата и автор выпуска.
              Незавершённые планы препятствуют статусу «Выпущен».
            </Alert>
          )}
          <Accordion variant="separated">
            <Accordion.Item value="description">
              <Accordion.Control>Полное описание выпуска</Accordion.Control>
              <Accordion.Panel>
                <MarkdownField
                  label="Описание"
                  key={form.key("description")}
                  {...form.getInputProps("description")}
                />
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        </fieldset>
        {hasPreviewError && (
          <Alert color="orange" title="Готовность состава недоступна">
            {preview.error?.message}
            <Button size="xs" variant="subtle" onClick={() => void preview.refresh()}>
              Повторить проверку
            </Button>
          </Alert>
        )}
        {hasError && (
          <Alert color="red" title="Релиз не сохранён">
            {error}
            <Button
              size="xs"
              variant="subtle"
              onClick={() => {
                clearReleaseDraft(draftKey);
                onClose();
              }}
            >
              Отбросить черновик и перечитать
            </Button>
          </Alert>
        )}
        <footer className={styles.footer}>
          <span>Черновик сохраняется в этой вкладке</span>
          <Group gap="xs">
            <Button variant="default" onClick={onClose}>
              Свернуть
            </Button>
            <Button type="submit" loading={form.submitting} disabled={!canSubmit}>
              {saveLabel}
            </Button>
          </Group>
        </footer>
      </form>
    </Modal>
  );
};
