import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  NativeSelect,
  SegmentedControl,
  Select,
  Switch,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useHotkeys } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { Check } from "lucide-react";
import { useBeforeUnload, useBlocker, useNavigate } from "react-router-dom";
import {
  DOCUMENT_KIND_OPTIONS,
  DOCUMENT_RELATION_TYPE_OPTIONS,
  DOCUMENT_STATUS_OPTIONS,
  DocumentAccessError,
  DocumentConflictError,
  MATERIAL_FORMAT_OPTIONS,
  MaterialTagsInput,
  useLibrarySettings,
  useMaterialMutations,
} from "domains/documents";
import type { DocumentInput } from "domains/documents";
import { useProjectBasePath, useProjectId } from "domains/project";
import { readSessionStored, removeSessionStored, writeSessionStored } from "infra/browser-storage";
import { MarkdownField } from "ui/markdown-field";
import { isDefined } from "shared/value-predicates";
import { DOCUMENTATION_DRAFT_SCHEMA } from "./config/documentation-draft.schema";
import { AttachmentTarget } from "./ui/attachment-target/attachment-target";
import type { DocumentationFormProps } from "./types/documentation-form-props.type";
import styles from "./styles/documentation-form.module.css";

/** Наибольшая длина адреса ссылки по контракту. */
const URL_LIMIT = 2048;

/** Проверяет адрес внешнего ресурса до записи, чтобы ошибка была видна у поля. */
const getUrlError = (value: string): string | null => {
  const url = value.trim();
  if (url === "") return "Укажите адрес ресурса";
  if (url.length > URL_LIMIT) return `Адрес длиннее ${URL_LIMIT} символов`;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return null;
  } catch {
    // Неразобранный адрес объясняется общим сообщением ниже.
  }
  return "Нужен полный адрес, начинающийся с https:// или http://, например https://example.com/guide";
};

/**
 * Редактирует материал библиотеки: документ в Markdown или внешнюю ссылку, свойства и теги,
 * а при создании из сущности — смысл и пояснение начального прикрепления.
 * Ввод сохраняется в вкладке при уходе, ошибке и конфликте ревизии.
 *
 * Используется для:
 *  - создания и изменения материала с сохранением идентичности и связей
 *  - разрешения конфликта ревизии без потери черновика
 */
export const DocumentationForm = (props: DocumentationFormProps) => {
  const {
    title,
    initial,
    documentId,
    revision,
    draftScope,
    attachment,
    cancelTo,
    createdReturnTo,
    catalogReturn,
    onReload,
    className,
    ...rootAttrs
  } = props;
  const projectId = useProjectId();
  const base = useProjectBasePath();
  const navigate = useNavigate();
  const settings = useLibrarySettings(projectId);
  const { saveMaterial } = useMaterialMutations(projectId);
  const requestsRef = useRef(new Map<string, string>());
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Прежняя восстановительная копия остаётся нетронутой в старом ключе.
  const draftKey = `relay:knowledge-draft:${draftScope}`;
  const [draftData] = useState(() =>
    DOCUMENTATION_DRAFT_SCHEMA.safeParse(readSessionStored(draftKey)),
  );
  const [baseRevision, setBaseRevision] = useState(
    draftData.success ? draftData.data.revision : revision,
  );
  const [hasRestoredDraft, setRestoredDraft] = useState(draftData.success);
  const [canPersist, setCanPersist] = useState(true);
  const [saveError, setSaveError] = useState("");
  const [isConflictError, setConflictError] = useState(false);
  const [defect, setDefect] = useState<Error>();
  const [isDiscardOpen, setDiscardOpen] = useState(false);
  const canLeaveRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const form = useForm<DocumentInput>({
    mode: "uncontrolled",
    validateInputOnBlur: true,
    initialValues: draftData.success ? draftData.data.values : initial,
    onValuesChange: (values) => {
      setCanPersist(writeSessionStored(draftKey, { values, revision: baseRevision }));
      setSaveError("");
    },
    validate: {
      name: (name) => (name.trim() === "" ? "Введите название материала" : null),
      url: (url, values) => (values.documentFormat === "link" ? getUrlError(url ?? "") : null),
      body: (body, values) =>
        values.documentFormat !== "link" && body.trim() === "" ? "Добавьте текст документа" : null,
    },
  });
  const format = form.useWatchValue("documentFormat") ?? "markdown";
  const tags = form.useWatchValue("tags") ?? [];
  const isLink = format === "link";
  const isNew = !isDefined(documentId);
  const sectionItems = (settings.data?.sections ?? []).map((section) => ({
    value: section.id,
    label: section.name,
  }));
  const isDirty = form.isDirty() || hasRestoredDraft;
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isDirty && !canLeaveRef.current && currentLocation.pathname !== nextLocation.pathname,
  );
  const isBlocked = blocker.state === "blocked";
  const hasSaveError = saveError !== "";
  const hasConflict = baseRevision !== revision;
  const draftLabel = isDirty ? "Есть несохранённые изменения" : "Изменений нет";
  const submitLabel = isNew ? "Создать материал" : "Сохранить материал";
  const summaryLabel = isLink ? "Назначение ссылки" : "Когда читать этот документ";
  const summaryDescription = isLink
    ? "Необязательно. Что найдёт человек или агент по ссылке и когда её открывать."
    : "Необязательно. Кратко объясните назначение — это увидят человек и агент в каталоге.";
  const bodyLabel = isLink ? "Пояснение к ссылке (необязательно)" : "Текст документа";
  const namePlaceholder = isLink
    ? "Например, макет экрана оплаты"
    : "Например, правила бронирования";
  const summaryPlaceholder = isLink
    ? "Например, актуальный макет; открывать при доработке оплаты"
    : "О чём этот документ и когда к нему обращаться";
  const bodyRows = isLink ? 6 : 16;
  const bodyPlaceholder = isLink
    ? "Что важно знать о ресурсе: какая часть актуальна, доступы, ограничения"
    : "## Задача\nЧто должно получиться и для кого.\n\n## Ожидаемое поведение\n1. …\n\n## Критерии приёмки\n- [ ] …";
  const saveErrorColor = isConflictError ? "orange" : "red";
  useEffect(() => {
    document.title = `${title} · Relay`;
    // Экран открывается с начала: прокрутка предыдущей страницы не прячет заголовок и поля.
    window.scrollTo({ top: 0 });
    headingRef.current?.focus({ preventScroll: true });
  }, [title]);
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
          if (
            !form.submitting &&
            !isBlocked &&
            !isDiscardOpen &&
            document.querySelector('[role="dialog"]') === null
          )
            formRef.current?.requestSubmit();
        },
      ],
    ],
    [],
  );
  if (defect !== undefined) throw defect;
  /**
   * Сохраняет материал и уходит только после успешной записи.
   * Новый материал записывается вместе с начальным прикреплением одной операцией.
   */
  const handleSubmit = async (values: DocumentInput): Promise<void> => {
    setSaveError("");
    setConflictError(false);
    const input: DocumentInput = { ...values, url: (values.url ?? "").trim() };
    try {
      const fingerprint = JSON.stringify([input, baseRevision]);
      const requestId = requestsRef.current.get(fingerprint) ?? crypto.randomUUID();
      requestsRef.current.set(fingerprint, requestId);
      const result = await saveMaterial(
        input,
        requestId,
        isDefined(documentId) ? { id: documentId, revision: baseRevision } : undefined,
      );
      requestsRef.current.delete(fingerprint);
      canLeaveRef.current = true;
      removeSessionStored(draftKey);
      notifications.show({
        position: "top-center",
        autoClose: 2500,
        title: isNew ? "Материал создан" : "Материал сохранён",
        message: isDefined(attachment)
          ? `Материал сохранён и прикреплён к «${attachment.title}».`
          : "Материал и его связи сохранены в библиотеке проекта.",
        color: "gray",
        closeButtonProps: { "aria-label": "Закрыть уведомление" },
      });
      if (isNew && createdReturnTo !== null) navigate(createdReturnTo, { replace: true });
      else
        navigate(`${base}/documents/${result.ref.id}`, {
          replace: true,
          state: { returnTo: catalogReturn },
        });
    } catch (failure) {
      if (failure instanceof DocumentConflictError) {
        setConflictError(true);
        setSaveError(
          "Материал изменили после того, как вы открыли редактор. Ваш ввод сохранён в этой вкладке — выберите, с какой версией продолжить.",
        );
      } else if (failure instanceof DocumentAccessError) setSaveError(failure.message);
      else setDefect(failure instanceof Error ? failure : new Error("Неожиданный сбой редактора"));
    }
  };
  /** Переводит фокус на первое поле с ошибкой. */
  const handleInvalid = (errors: typeof form.errors): void => {
    const field = Object.keys(errors)[0];
    if (field === undefined) return;
    if (field === "body") {
      // Редактор Markdown загружается асинхронно: ждём его поле ввода несколько кадров.
      const focusBody = (attempt: number): void => {
        const editor = formRef.current?.querySelector<HTMLElement>(
          '[data-body-field] [contenteditable="true"]',
        );
        if (editor) {
          editor.focus({ preventScroll: true });
          // Ошибка выводится под редактором: прокручиваем так, чтобы были видны поле и ошибка.
          const field = formRef.current?.querySelector<HTMLElement>("[data-body-field]");
          field?.scrollIntoView({ block: "end" });
        } else if (attempt < 20) requestAnimationFrame(() => focusBody(attempt + 1));
      };
      focusBody(0);
      return;
    }
    form.getInputNode(field)?.focus();
  };
  /** Удаляет ввод только после явной отмены. */
  const handleDiscard = (): void => {
    canLeaveRef.current = true;
    removeSessionStored(draftKey);
    navigate(cancelTo, { state: { returnTo: catalogReturn } });
  };
  /** Оставляет ввод и применяет его к актуальной ревизии при следующем сохранении. */
  const handleKeepDraft = (): void => {
    setBaseRevision(revision);
    setCanPersist(writeSessionStored(draftKey, { values: form.getValues(), revision }));
    setSaveError("");
    setConflictError(false);
  };
  /** Заменяет ввод актуальной записью по явному выбору человека. */
  const handleUseCurrent = (): void => {
    form.setValues(initial);
    form.resetDirty(initial);
    setBaseRevision(revision);
    setRestoredDraft(false);
    setSaveError("");
    setConflictError(false);
    removeSessionStored(draftKey);
  };
  return (
    <form
      {...rootAttrs}
      ref={formRef}
      className={clsx(styles.root, className)}
      noValidate
      onSubmit={form.onSubmit(handleSubmit, handleInvalid)}
    >
      <header className={styles.header}>
        <h1 ref={headingRef} tabIndex={-1} className={styles.heading}>
          {title}
        </h1>
        <p className={styles.lead}>
          Материал — документ в Markdown или ссылка на внешний ресурс. Тип, раздел и теги помогут
          найти его, а прикрепления — держать под рукой там, где он нужен.
        </p>
      </header>
      {hasRestoredDraft && (
        <Alert color="gray">
          Восстановлена локальная копия этой вкладки. Сохраните материал, чтобы правки стали
          доступны всем.
        </Alert>
      )}
      {hasConflict && (
        <Alert color="orange" title="Материал изменился" role="alert">
          Пока вы редактировали, материал сохранили в другом месте. Ваш ввод не потерян.
          <Group gap="xs" mt="sm">
            <Button size="xs" variant="default" onClick={handleKeepDraft}>
              Оставить мой ввод
            </Button>
            <Button size="xs" variant="subtle" color="gray" onClick={handleUseCurrent}>
              Загрузить актуальную версию
            </Button>
          </Group>
        </Alert>
      )}
      {!canPersist && (
        <Alert color="orange" role="alert">
          Не удалось сохранить черновик в браузере. Не закрывайте страницу до сохранения.
        </Alert>
      )}
      <fieldset className={styles.fields} disabled={form.submitting}>
        <section className={styles.editor} aria-labelledby="material-content-title">
          <h2 id="material-content-title" className={styles.title}>
            Содержание
          </h2>
          <div className={styles.field}>
            <Text size="sm" fw={500} id="material-format-label">
              Формат материала
            </Text>
            <SegmentedControl
              aria-labelledby="material-format-label"
              data={MATERIAL_FORMAT_OPTIONS}
              className={styles.format}
              key={form.key("documentFormat")}
              {...form.getInputProps("documentFormat")}
            />
            <Text size="xs" c="dimmed">
              Смена формата не меняет материал: адрес, связи и свойства сохраняются.
            </Text>
          </div>
          <TextInput
            key={form.key("name")}
            label="Название"
            placeholder={namePlaceholder}
            required
            {...form.getInputProps("name")}
          />
          {isLink && (
            <TextInput
              key={form.key("url")}
              label="Адрес ресурса"
              placeholder="https://"
              type="url"
              inputMode="url"
              autoComplete="url"
              required
              description="Relay хранит адрес, а не копию страницы, и не проверяет её доступность."
              {...form.getInputProps("url")}
            />
          )}
          <Textarea
            key={form.key("summary")}
            label={summaryLabel}
            description={summaryDescription}
            autosize
            minRows={2}
            placeholder={summaryPlaceholder}
            {...form.getInputProps("summary")}
          />
          <div data-body-field className={styles.body}>
            <MarkdownField
              key={form.key("body")}
              label={bodyLabel}
              minRows={bodyRows}
              placeholder={bodyPlaceholder}
              {...form.getInputProps("body")}
            />
          </div>
        </section>
        <aside className={styles.aside} aria-label="Свойства материала">
          {isDefined(attachment) && (
            <AttachmentTarget
              className={styles.card}
              title={attachment.title}
              entityKey={attachment.entityKey}
              kindLabel={attachment.kindLabel}
            >
              <Select
                label="Смысл связи"
                data={DOCUMENT_RELATION_TYPE_OPTIONS}
                allowDeselect={false}
                key={form.key("relations.0.type")}
                {...form.getInputProps("relations.0.type")}
              />
              <Textarea
                label="Зачем нужен этот материал здесь"
                description="Необязательно · Markdown"
                autosize
                minRows={2}
                key={form.key("relations.0.description")}
                {...form.getInputProps("relations.0.description")}
              />
            </AttachmentTarget>
          )}
          <section className={styles.card} aria-labelledby="material-properties-title">
            <h2 id="material-properties-title" className={styles.title}>
              Свойства
            </h2>
            <NativeSelect
              key={form.key("documentKind")}
              label="Тип"
              description="Назначение: правила, решение, инструкция…"
              data={DOCUMENT_KIND_OPTIONS}
              {...form.getInputProps("documentKind")}
            />
            <Select
              label="Раздел библиотеки"
              placeholder="Без раздела"
              clearable
              data={sectionItems}
              key={form.key("sectionId")}
              {...form.getInputProps("sectionId")}
            />
            <NativeSelect
              label="Состояние"
              description="Черновик доступен команде, но ещё не является принятым решением."
              data={DOCUMENT_STATUS_OPTIONS}
              key={form.key("documentStatus")}
              {...form.getInputProps("documentStatus")}
            />
            <MaterialTagsInput
              projectId={projectId}
              label="Теги"
              description="Выберите существующие или введите новый и нажмите Enter."
              placeholder="Добавить тег"
              value={tags}
              disabled={form.submitting}
              onChange={(next) => form.setFieldValue("tags", next)}
            />
            <Switch
              label="Закрепить в библиотеке"
              key={form.key("pinned")}
              {...form.getInputProps("pinned", { type: "checkbox" })}
            />
          </section>
        </aside>
      </fieldset>
      {hasSaveError && (
        <Alert color={saveErrorColor} role="alert" title="Не удалось сохранить">
          {saveError}
          {isConflictError && !hasConflict && (
            <Group gap="xs" mt="sm">
              <Button size="xs" variant="default" onClick={onReload}>
                Перечитать материал
              </Button>
            </Group>
          )}
        </Alert>
      )}
      <footer className={styles.footer}>
        <div>
          <Badge color="gray" variant="light" tt="none" fw={500} role="status">
            {draftLabel}
          </Badge>
          <Text size="xs" c="dimmed" mt={5}>
            Локальная копия в этой вкладке · Ctrl/⌘ + Enter
          </Text>
        </div>
        <Group gap="xs">
          <Button
            variant="default"
            radius="xl"
            disabled={form.submitting}
            onClick={() => {
              if (isDirty) setDiscardOpen(true);
              else handleDiscard();
            }}
          >
            Отмена
          </Button>
          <Button
            type="submit"
            radius="xl"
            loading={form.submitting}
            leftSection={<Check size={16} aria-hidden="true" />}
          >
            {submitLabel}
          </Button>
        </Group>
      </footer>
      <Modal
        opened={isBlocked}
        onClose={() => blocker.reset?.()}
        title="Есть несохранённые изменения"
        centered
        closeButtonProps={{ "aria-label": "Остаться в редакторе" }}
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
        title="Отменить правки?"
        centered
        closeButtonProps={{ "aria-label": "Продолжить редактирование" }}
      >
        <Text size="sm">Несохранённый ввод и черновик этого материала будут удалены.</Text>
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
