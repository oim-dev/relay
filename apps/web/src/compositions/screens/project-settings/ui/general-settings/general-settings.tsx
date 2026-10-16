import clsx from "clsx";
import { useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Button,
  CopyButton,
  Group,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { CircleAlert, Copy, Fingerprint, Link2, TriangleAlert } from "lucide-react";
import { ProjectSettingsError, useProjectId, useSaveProjectSettings } from "domains/project";
import type { ProjectSettings } from "domains/project";
import { readSessionStored, writeSessionStored, removeSessionStored } from "infra/browser-storage";
import { isDefined } from "shared/value-predicates";
import type { GeneralSettingsProps } from "./types/general-settings-props.type";
import { SETTINGS_DRAFT_SCHEMA } from "./config/form.schema";
import type { SettingsFormValues } from "./config/form.schema";
import styles from "./styles/general-settings.module.css";

/**
 * Управляет именем и адресом проекта с явным сохранением и защитой черновика.
 *
 * Используется для:
 *  - проверки ввода, сохранения и отмены изменений
 *  - восстановления черновика и разрешения конфликта с сервером
 */
export const GeneralSettings = (props: GeneralSettingsProps) => {
  const { settings, className, ...rootAttrs } = props;
  const projectId = useProjectId();
  const save = useSaveProjectSettings();
  const draftKey = `relay:project-settings:${projectId}`;
  const [initialDraft] = useState(() =>
    SETTINGS_DRAFT_SCHEMA.safeParse(readSessionStored(draftKey)),
  );
  const draftData = initialDraft.success ? initialDraft.data : undefined;
  const [baseRevision, setBaseRevision] = useState(draftData?.ifRevision ?? settings.revision);
  const [error, setError] = useState("");
  const [hasSaved, setSaved] = useState(false);
  const [hasDraftStorageError, setDraftStorageError] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const form = useForm<SettingsFormValues>({
    name: "project-settings",
    mode: "uncontrolled",
    initialValues: {
      name: draftData?.name ?? settings.name,
      slug: draftData?.slug ?? settings.slug,
    },
    validateInputOnBlur: true,
    validate: {
      name: (name) =>
        name.trim().length === 0
          ? "Введите имя проекта"
          : name.trim().length > 120
            ? "Не больше 120 символов"
            : /\p{Cc}/u.test(name)
              ? "Имя должно быть однострочным текстом"
              : null,
      slug: (slug) =>
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length >= 2 && slug.length <= 64
          ? null
          : "От 2 до 64 символов: a–z, 0–9 и одиночные дефисы между словами",
    },
    onValuesChange: (values) => {
      setSaved(false);
      setError("");
      setDraftStorageError(!writeSessionStored(draftKey, { ...values, ifRevision: baseRevision }));
    },
  });
  const nameValue = form.useWatchValue("name");
  const slugValue = form.useWatchValue("slug");
  const hasChanges = nameValue !== settings.name || slugValue !== settings.slug;
  const hasConflict = settings.revision > baseRevision && !form.submitting;
  const hasError = error !== "";
  const canSave = hasChanges && !hasConflict;
  const canReset = hasChanges || hasConflict;
  const displayName = nameValue.trim() || "Ваш проект";
  const monogram = Array.from(displayName).slice(0, 2).join("").toLocaleUpperCase("ru");
  const previewPath = `/projects/${slugValue || "your-project"}`;
  const statusLabel = hasChanges
    ? "Есть несохранённые изменения"
    : hasSaved
      ? "Изменения сохранены"
      : "Все изменения сохранены";
  const currentSettingsLabel = `${settings.name} · /projects/${settings.slug}`;

  /**
   * Принимает подтверждённые значения как новую исходную версию формы.
   */
  const acceptSettings = (confirmed: ProjectSettings): void => {
    const values = { name: confirmed.name, slug: confirmed.slug };
    form.setInitialValues(values);
    form.setValues(values);
    form.resetDirty(values);
    form.clearErrors();
    setBaseRevision(confirmed.revision);
    removeSessionStored(draftKey);
    setError("");
    setDraftStorageError(false);
  };

  /**
   * Возвращает фокус после действия, которое сделало нажатую кнопку недоступной или убрало её.
   * Цель появляется после отрисовки нового состояния, поэтому фокус ставится в следующем кадре.
   */
  const restoreFocus = (getTarget: () => HTMLElement | null): void => {
    requestAnimationFrame(() => getTarget()?.focus());
  };

  /**
   * Сохраняет пару настроек; при отказе оставляет введённый текст.
   */
  const handleSubmit = async (values: SettingsFormValues): Promise<void> => {
    if (!canSave || form.submitting) return;
    setError("");
    try {
      const confirmed = await save({
        name: values.name.trim(),
        slug: values.slug,
        ifRevision: baseRevision,
      });
      acceptSettings(confirmed);
      setSaved(true);
      // Обе кнопки формы стали недоступны: фокус — к началу раздела, статус объявит итог.
      restoreFocus(() => titleRef.current);
    } catch (failure) {
      if (failure instanceof ProjectSettingsError && failure.code === "PROJECT_SLUG_TAKEN") {
        form.setFieldError("slug", failure.message);
        restoreFocus(() => form.getInputNode("slug") ?? null);
        return;
      }
      if (failure instanceof ProjectSettingsError) setError(failure.message);
      else {
        console.error("Неожиданная ошибка сохранения настроек проекта", failure);
        setError("Не удалось обработать ответ сервера. Введённые значения сохранены.");
      }
      restoreFocus(() => errorRef.current);
    }
  };

  /**
   * Переводит фокус к первому полю с ошибкой.
   */
  const handleValidationError = (errors: typeof form.errors): void => {
    const firstPath = Object.keys(errors)[0];
    // Mantine снимает submitting после этого callback; фокусируем уже доступный fieldset.
    if (isDefined(firstPath)) requestAnimationFrame(() => form.getInputNode(firstPath)?.focus());
  };

  /**
   * Отменяет локальный ввод в пользу последнего снимка сервера.
   */
  const handleReset = (): void => {
    acceptSettings(settings);
    setSaved(false);
    restoreFocus(() => titleRef.current);
  };

  /**
   * После явного выбора пользователя разрешает сохранить его вариант поверх новой версии.
   */
  const handleKeepDraft = (): void => {
    setBaseRevision(settings.revision);
    setError("");
    setDraftStorageError(
      !writeSessionStored(draftKey, { ...form.getValues(), ifRevision: settings.revision }),
    );
    // Предупреждение о конфликте исчезает; следующий шаг — сохранить свой вариант.
    restoreFocus(() => submitRef.current);
  };

  return (
    <section
      {...rootAttrs}
      id="general"
      className={clsx(styles.root, className)}
      aria-labelledby="general-settings-title"
    >
      <form
        noValidate
        onSubmit={form.onSubmit(handleSubmit, handleValidationError)}
        className={styles.card}
      >
        <header className={styles.introduction}>
          <div className={styles.monogram} aria-hidden="true">
            {monogram}
          </div>
          <div className={styles.introductionText}>
            <Title
              ref={titleRef}
              order={2}
              id="general-settings-title"
              size="h3"
              tabIndex={-1}
              className={styles.title}
            >
              Основное
            </Title>
            <Text size="sm" c="dimmed" mt={4}>
              Имя, по которому узнают проект. Адрес, по которому его находят.
            </Text>
          </div>
        </header>
        <fieldset disabled={form.submitting} className={styles.fields}>
          <div className={styles.fieldRow}>
            <div className={styles.fieldLabel}>
              <label htmlFor="project-name">Имя проекта</label>
              <Text size="xs" c="dimmed" mt={4}>
                В шапке и списке проектов
              </Text>
            </div>
            <div className={styles.fieldInput}>
              <TextInput
                id="project-name"
                key={form.key("name")}
                maxLength={120}
                placeholder="Например, Мастерская"
                autoComplete="off"
                required
                {...form.getInputProps("name")}
              />
              <Text size="sm" c="dimmed" mt="xs">
                Короткое и понятное название. Можно на русском.
              </Text>
            </div>
          </div>
          <div className={styles.fieldRow}>
            <div className={styles.fieldLabel}>
              <label htmlFor="project-slug">Slug проекта</label>
              <Text size="xs" c="dimmed" mt={4}>
                Уникальный адрес в Relay
              </Text>
            </div>
            <div className={styles.fieldInput}>
              <TextInput
                id="project-slug"
                key={form.key("slug")}
                maxLength={64}
                placeholder="my-project"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                leftSection={<Link2 size={16} aria-hidden="true" />}
                required
                {...form.getInputProps("slug")}
              />
              <Text size="sm" c="dimmed" mt="xs">
                Латинские буквы в нижнем регистре, цифры и дефисы.
              </Text>
              <div className={styles.addressPreview}>
                <span className={styles.addressLabel}>Адрес проекта</span>
                <code className={styles.address}>{previewPath}</code>
              </div>
              <Text size="sm" c="dimmed" mt="sm">
                При смене slug адрес обновится. Ссылки по постоянному ID продолжат работать.
              </Text>
            </div>
          </div>
        </fieldset>
        {hasConflict && (
          <Alert
            color="warning"
            title="Настройки изменились в другом окне"
            icon={<TriangleAlert size={18} aria-hidden="true" />}
            className={styles.feedback}
          >
            <Text size="sm">Ваш ввод сохранён. Сейчас на сервере: {currentSettingsLabel}</Text>
            <Group gap="xs" mt="sm">
              <Button size="xs" variant="default" onClick={handleReset}>
                Загрузить актуальные
              </Button>
              <Button size="xs" variant="subtle" color="gray" onClick={handleKeepDraft}>
                Оставить мой вариант
              </Button>
            </Group>
          </Alert>
        )}
        {hasError && (
          <Alert
            ref={errorRef}
            color="danger"
            title="Не удалось сохранить"
            tabIndex={-1}
            icon={<CircleAlert size={18} aria-hidden="true" />}
            className={styles.feedback}
          >
            {error}
          </Alert>
        )}
        {hasDraftStorageError && (
          <Alert
            color="warning"
            icon={<TriangleAlert size={18} aria-hidden="true" />}
            className={styles.feedback}
          >
            Браузер не сохранил черновик. Не закрывайте страницу до сохранения.
          </Alert>
        )}
        <footer className={styles.footer}>
          <span className={styles.status} role="status">
            <span
              className={clsx(styles.statusDot, hasChanges && styles._changed)}
              aria-hidden="true"
            />
            {statusLabel}
          </span>
          <Group gap="xs" className={styles.buttons}>
            <Button
              variant="subtle"
              color="gray"
              onClick={handleReset}
              disabled={!canReset || form.submitting}
            >
              Отменить
            </Button>
            <Button ref={submitRef} type="submit" disabled={!canSave} loading={form.submitting}>
              Сохранить изменения
            </Button>
          </Group>
        </footer>
      </form>
      <div className={styles.identity}>
        <Fingerprint size={20} aria-hidden="true" className={styles.identityIcon} />
        <div className={styles.identityText}>
          <Text size="sm" fw={550}>
            Постоянный ID проекта
          </Text>
          <Text size="sm" c="dimmed" mt={4}>
            Не меняется вместе с именем и адресом. Связи и данные остаются на месте.
          </Text>
        </div>
        <Group gap={5} wrap="nowrap" className={styles.identityValue}>
          <code>{projectId}</code>
          <CopyButton value={projectId}>
            {({ copy }) => (
              <Tooltip label="Скопировать ID">
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label="Скопировать ID проекта"
                  onClick={copy}
                >
                  <Copy size={16} aria-hidden="true" />
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
        </Group>
      </div>
    </section>
  );
};
