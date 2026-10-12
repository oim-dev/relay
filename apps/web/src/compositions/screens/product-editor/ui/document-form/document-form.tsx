import clsx from "clsx";
import { useRef, useState } from "react";
import { Alert, Button, Group, Modal, NativeSelect, Text, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useHotkeys } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useBeforeUnload, useBlocker, useLocation, useNavigate } from "react-router-dom";
import { APPLICATION_TYPES, useProductDemo } from "domains/product-demo";
import { APPLICATION_SLUG_SCHEMA } from "domains/product";
import { useProductPath } from "compositions/widgets/product-page";
import { readSessionStored, writeSessionStored, removeSessionStored } from "infra/browser-storage";
import { MarkdownField } from "ui/markdown-field";
import { StatusBadge } from "ui/status-badge";
import { PRODUCT_DRAFT_SCHEMA } from "./config/form.schema";
import { createFormValues } from "./helpers/create-form-values";
import type { ProductFormValues } from "./types/product-form-values.type";
import type { DocumentFormProps } from "./types/document-form-props.type";
import styles from "./styles/document-form.module.css";

/**
 * Редактирует общие сведения документа с локальным черновиком.
 *
 * Используется для:
 *  - предпросмотра Markdown, сохранения и явной отмены
 *  - восстановления ввода после ошибки, перезагрузки или перехода
 */
export const DocumentForm = (props: DocumentFormProps) => {
  const { initial, revision, draftScope, backTo, className, ...rootAttrs } = props;
  const { saveDocument } = useProductDemo();
  const base = useProductPath();
  const navigate = useNavigate();
  const location = useLocation();
  const draftKey = `relay:product-draft:${base}:${draftScope}`;
  const [draftData] = useState(() => PRODUCT_DRAFT_SCHEMA.safeParse(readSessionStored(draftKey)));
  const [baseRevision, setBaseRevision] = useState(() =>
    draftData.success ? draftData.data.revision : revision,
  );
  const [hasRestoredDraft, setRestoredDraft] = useState(draftData.success);
  const [canPersist, setCanPersist] = useState(true);
  const [saveError, setSaveError] = useState("");
  const [defect, setDefect] = useState<Error | undefined>();
  const [isDiscardOpen, setDiscardOpen] = useState(false);
  const canLeaveRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const saveErrorRef = useRef<HTMLDivElement>(null);
  const isFeature = initial.kind === "features";
  const isScenario = initial.kind === "scenarios";
  const hasSummary = !isScenario;
  const isApplication = initial.kind === "applications";
  const isExistingApplication = isApplication && initial.id !== "";
  const form = useForm<ProductFormValues>({
    mode: "uncontrolled",
    validateInputOnBlur: true,
    initialValues: draftData.success ? draftData.data.values : createFormValues(initial),
    onValuesChange: (values) => {
      setCanPersist(writeSessionStored(draftKey, { values, revision: baseRevision }));
      setSaveError("");
    },
    validate: {
      name: (name) => (name.trim() === "" ? "Введите название" : null),
      prefix: (prefix) =>
        !isApplication || prefix === "" || /^[A-Z][A-Z0-9]{1,15}$/.test(prefix)
          ? null
          : "Префикс: 2–16 заглавных латинских букв и цифр; первый символ — буква",
      slug: (slug) =>
        !isApplication || APPLICATION_SLUG_SCHEMA.safeParse(slug).success
          ? null
          : "Укажите уникальный адрес: латинские строчные буквы, цифры и дефисы, до 64 символов. product, infrastructure и new зарезервированы.",
      summary: (summary) =>
        !isScenario && summary.trim() === "" ? "Кратко опишите назначение" : null,
      description: (description) => (description.trim() === "" ? "Добавьте описание" : null),
    },
  });
  const isDirty = form.isDirty() || hasRestoredDraft;
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isDirty && !canLeaveRef.current && currentLocation.pathname !== nextLocation.pathname,
  );
  const isBlocked = blocker.state === "blocked";
  const hasSaveError = saveError !== "";
  const hasNewerSnapshot = baseRevision !== revision;
  const draftLabel = isDirty ? "Есть несохранённые изменения" : "Изменений нет";
  const draftTone = isDirty ? "warning" : "neutral";
  const recordLabel = isScenario
    ? "сценария"
    : isFeature
      ? "фичи"
      : isApplication
        ? "приложения"
        : "паспорта продукта";
  useBeforeUnload((event) => {
    if (isDirty && !canPersist) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  useHotkeys(
    [
      [
        "mod+Enter",
        () => {
          if (!form.submitting && !isBlocked && !isDiscardOpen) formRef.current?.requestSubmit();
        },
      ],
    ],
    [],
  );
  /**
   * Сохраняет проверенные сведения, не очищая форму при отказе.
   */
  const handleSubmit = async (values: ProductFormValues): Promise<void> => {
    setSaveError("");
    try {
      const saveResult = await saveDocument({ ...initial, ...values }, baseRevision);
      if (!saveResult.isSaved) {
        setSaveError(saveResult.message);
        // Кнопка «Сохранить» была недоступна во время запроса и потеряла фокус:
        // переводим его к сообщению об ошибке, после него — к той же кнопке.
        requestAnimationFrame(() => saveErrorRef.current?.focus());
        return;
      }
      canLeaveRef.current = true;
      removeSessionStored(draftKey);
      setRestoredDraft(false);
      form.resetDirty(values);
      const nextPath =
        initial.id !== ""
          ? backTo
          : isScenario
            ? `${base}/features/${initial.featureId}/scenarios/${saveResult.id}${location.search}`
            : initial.kind === "passport"
              ? `${base}/passport`
              : `${base}/${initial.kind}/${saveResult.id}${location.search}`;
      notifications.show({
        position: "top-center",
        autoClose: 2500,
        title: "Сохранено",
        message: isScenario
          ? "Сценарий сохранён. Готовность фичи пересчитана."
          : "Описание продукта обновлено.",
        color: "success",
        closeButtonProps: { "aria-label": "Закрыть уведомление" },
      });
      navigate(nextPath, { replace: true, state: location.state });
    } catch {
      setDefect(new Error("Неожиданный сбой редактора продукта"));
    }
  };
  /**
   * Фокусирует первое некорректное поле.
   */
  const handleInvalid = (errors: typeof form.errors): void => {
    const path = Object.keys(errors)[0];
    if (path === undefined) return;
    const inputNode = form.getInputNode(path);
    if (inputNode !== null) inputNode.focus();
    else formRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  };
  /**
   * Удаляет черновик только по явной отмене.
   */
  const handleDiscard = (): void => {
    canLeaveRef.current = true;
    removeSessionStored(draftKey);
    navigate(backTo, { state: location.state });
  };
  /**
   * Подтверждает отмену изменённого ввода.
   */
  const handleCancel = (): void => {
    if (isDirty) setDiscardOpen(true);
    else handleDiscard();
  };
  /**
   * Подтверждает применение черновика к обновлённой модели.
   */
  const handleKeepDraft = (): void => {
    setBaseRevision(revision);
    setCanPersist(writeSessionStored(draftKey, { values: form.getValues(), revision }));
    setSaveError("");
  };
  /**
   * Явно загружает актуальный документ вместо черновика.
   */
  const handleUseCurrent = (): void => {
    const currentValues = createFormValues(initial);
    form.setValues(currentValues);
    form.resetDirty(currentValues);
    setBaseRevision(revision);
    setRestoredDraft(false);
    setSaveError("");
    removeSessionStored(draftKey);
  };
  if (defect !== undefined) throw defect;
  return (
    <form
      {...rootAttrs}
      ref={formRef}
      noValidate
      onSubmit={form.onSubmit(handleSubmit, handleInvalid)}
      className={clsx(styles.root, className)}
    >
      {hasRestoredDraft && <Alert>Восстановлен несохранённый черновик этой вкладки.</Alert>}
      {hasNewerSnapshot && (
        <Alert color="warning" title="Данные продукта изменились" role="alert">
          Ваш ввод сохранён. Выберите, с какой версией продолжить.
          <Group mt="sm" gap="xs">
            <Button variant="default" size="xs" onClick={handleKeepDraft}>
              Оставить мой ввод
            </Button>
            <Button variant="subtle" size="xs" onClick={handleUseCurrent}>
              Загрузить актуальную версию
            </Button>
          </Group>
        </Alert>
      )}
      {!canPersist && (
        <Alert color="warning" role="alert">
          Браузер не смог сохранить черновик. Не закрывайте страницу до успешного сохранения.
        </Alert>
      )}
      <fieldset disabled={form.submitting} className={styles.fields}>
        <TextInput
          key={form.key("name")}
          label="Название"
          required
          {...form.getInputProps("name")}
        />
        {hasSummary && (
          <TextInput
            key={form.key("summary")}
            label="Краткий смысл"
            description="Одна фраза для быстрого чтения списка."
            required
            {...form.getInputProps("summary")}
          />
        )}
        {isFeature && (
          <Text size="sm" c="dimmed">
            Готовность вычисляется по контрактам всех приложений и сценариям. Сценарии добавляются и
            редактируются на странице фичи.
          </Text>
        )}
        {isScenario && (
          <Text size="sm" c="dimmed">
            Сценарий готов, когда все участвующие приложения подтвердили реализацию его актуальных
            требований.
          </Text>
        )}
        {isApplication && (
          <TextInput
            key={form.key("slug")}
            label="Адрес приложения и доски"
            description="Slug в URL и имя папки доски. Задаётся при создании и не меняется при переименовании приложения."
            placeholder="storefront"
            required
            readOnly={isExistingApplication}
            {...form.getInputProps("slug")}
          />
        )}
        {isApplication && (
          <TextInput
            key={form.key("prefix")}
            label="Префикс задач доски"
            description="Например WEB или API. Если оставить пустым, создаётся из адреса доски. После создания не меняется."
            placeholder="WEB"
            readOnly={isExistingApplication}
            {...form.getInputProps("prefix")}
          />
        )}
        {isApplication && (
          <NativeSelect
            key={form.key("type")}
            label="Тип приложения"
            data={APPLICATION_TYPES}
            {...form.getInputProps("type")}
          />
        )}
        <MarkdownField
          key={form.key("description")}
          label="Описание в Markdown"
          minRows={12}
          {...form.getInputProps("description")}
        />
        {isApplication && (
          <Text size="sm" c="dimmed">
            Выбрать фичи и сценарии и описать свой вклад можно на странице приложения после
            сохранения.
          </Text>
        )}
      </fieldset>
      {hasSaveError && (
        <Alert
          ref={saveErrorRef}
          color="danger"
          role="alert"
          title="Не удалось сохранить"
          tabIndex={-1}
        >
          {saveError}
        </Alert>
      )}
      <footer className={styles.footer}>
        <div>
          <StatusBadge tone={draftTone} role="status">
            {draftLabel}
          </StatusBadge>
          <Text size="xs" c="dimmed" mt={6}>
            Черновик остаётся в этой вкладке · Ctrl/⌘ + Enter
          </Text>
        </div>
        <Group gap="xs">
          <Button type="button" variant="default" disabled={form.submitting} onClick={handleCancel}>
            Отмена
          </Button>
          <Button type="submit" loading={form.submitting}>
            Сохранить
          </Button>
        </Group>
      </footer>
      <Modal
        opened={isBlocked}
        onClose={() => blocker.reset?.()}
        closeButtonProps={{ "aria-label": "Остаться в редакторе" }}
        title="Есть несохранённые изменения"
        centered
      >
        <Text size="sm">
          Можно продолжить редактирование или перейти дальше с сохранённым черновиком.
        </Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => blocker.reset?.()}>
            Остаться
          </Button>
          <Button disabled={!canPersist} onClick={() => blocker.proceed?.()}>
            Перейти с черновиком
          </Button>
        </Group>
      </Modal>
      <Modal
        opened={isDiscardOpen}
        onClose={() => setDiscardOpen(false)}
        closeButtonProps={{ "aria-label": "Продолжить редактирование" }}
        title="Отменить правки?"
        centered
      >
        <Text size="sm">Несохранённый ввод и локальный черновик {recordLabel} будут удалены.</Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => setDiscardOpen(false)}>
            Продолжить редактирование
          </Button>
          <Button onClick={handleDiscard}>Отменить правки</Button>
        </Group>
      </Modal>
    </form>
  );
};
