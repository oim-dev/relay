import clsx from "clsx";
import { useRef, useState } from "react";
import { Alert, Button, Group, Modal, Text } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useHotkeys } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useBeforeUnload, useBlocker, useNavigate } from "react-router-dom";
import { useProductDemo } from "domains/product-demo";
import { useProductPath } from "compositions/widgets/product-page";
import { readSessionStored, removeSessionStored, writeSessionStored } from "infra/browser-storage";
import { StatePanel } from "ui/state-panel";
import { isDefined } from "shared/value-predicates";
import { SCOPE_DRAFT_SCHEMA } from "./config/scope-form.schema";
import { createScopeValues } from "./helpers/create-scope-values";
import { validateScopeValues } from "./helpers/validate-scope-values";
import { getScopeEditor } from "./helpers/get-scope-editor";
import { ScopeTree } from "./ui/scope-tree";
import { ScopeEditor } from "./ui/scope-editor";
import type { ScopeFormValues, ScopeTarget } from "./types/scope-form-values.type";
import type { ApplicationScopeFormProps } from "./types/application-scope-form-props.type";
import styles from "./styles/application-scope-form.module.css";

/**
 * Владеет выбором и текстами вкладов приложения с общим черновиком и явным сохранением.
 *
 * Используется для:
 *  - переключения между описаниями без потери ввода
 *  - восстановления после ошибок и разрешения конфликта версии
 */
export const ApplicationScopeForm = (props: ApplicationScopeFormProps) => {
  const {
    application,
    features,
    contributions,
    revision,
    draftScope,
    backTo,
    initialFeatureId,
    initialScenarioId,
    className,
    ...rootAttrs
  } = props;
  const { saveApplicationScope } = useProductDemo();
  const base = useProductPath();
  const navigate = useNavigate();
  const draftKey = `relay:application-scope-draft:${base}:${draftScope}`;
  const [draft] = useState(() => SCOPE_DRAFT_SCHEMA.safeParse(readSessionStored(draftKey)));
  const [baseRevision, setBaseRevision] = useState(draft.success ? draft.data.revision : revision);
  const [hasRestoredDraft, setRestoredDraft] = useState(draft.success);
  const [canPersist, setCanPersist] = useState(true);
  const [saveError, setSaveError] = useState("");
  const [defect, setDefect] = useState<Error>();
  const [isDiscardOpen, setDiscardOpen] = useState(false);
  const [isEditing, setEditing] = useState(initialFeatureId !== undefined);
  const [target, setTarget] = useState<ScopeTarget | undefined>(() => {
    const featureId = initialFeatureId ?? contributions[0]?.featureId ?? features[0]?.id;
    if (featureId === undefined) return undefined;
    return { featureId, scenarioId: initialScenarioId };
  });
  const canLeaveRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<HTMLDivElement>(null);
  const form = useForm<ScopeFormValues>({
    mode: "uncontrolled",
    validateInputOnBlur: true,
    initialValues: createScopeValues(
      features,
      contributions,
      draft.success ? draft.data.values : undefined,
    ),
    onValuesChange: (values) => {
      setCanPersist(writeSessionStored(draftKey, { values, revision: baseRevision }));
      setSaveError("");
    },
    validate: validateScopeValues,
  });
  const featureValues = form.useWatchValue("features");
  const values = { features: featureValues };
  const isDirty = form.isDirty() || hasRestoredDraft;
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isDirty && !canLeaveRef.current && currentLocation.pathname !== nextLocation.pathname,
  );
  const isBlocked = blocker.state === "blocked";
  const hasConflict = baseRevision !== revision;
  const hasSaveError = saveError !== "";
  const dirtyLabel = isDirty ? "Есть несохранённые изменения" : "Изменений нет";
  const selectedFeatures = featureValues.filter((entry) => entry.isEnabled);
  const scenarioCount = selectedFeatures.reduce(
    (count, entry) => count + entry.scenarios.filter((scenario) => scenario.isEnabled).length,
    0,
  );
  const editor = getScopeEditor(features, values, target);
  const selectionItems = featureValues.flatMap((entry) => {
    const feature = features.find((item) => item.id === entry.featureId);
    if (feature === undefined) return [];
    return [
      {
        id: feature.id,
        key: feature.key,
        name: feature.name,
        isEnabled: entry.isEnabled,
        hasDescription: entry.title.trim() !== "" && entry.description.trim() !== "",
        status: entry.status,
        scenarios: feature.scenarios.map((scenario) => {
          const selected = entry.scenarios.find((item) => item.scenarioId === scenario.id);
          return {
            id: scenario.id,
            key: scenario.key,
            name: scenario.name,
            isEnabled: entry.isEnabled && selected?.isEnabled === true,
            hasDescription:
              selected !== undefined &&
              selected.title.trim() !== "" &&
              selected.description.trim() !== "",
            status: selected?.status ?? "none",
          };
        }),
      },
    ];
  });
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
   * Открывает описание; фокус заголовка не вызывает клавиатуру ввода на мобильном.
   */
  const handleInspect = (featureId: string, scenarioId?: string): void => {
    setTarget({ featureId, scenarioId });
    setEditing(true);
    requestAnimationFrame(() =>
      editorRef.current?.querySelector<HTMLHeadingElement>("h2")?.focus(),
    );
  };
  /**
   * Возвращает мобильный выбор к элементу, описание которого было открыто.
   */
  const handleBackToSelection = (): void => {
    setEditing(false);
    requestAnimationFrame(() =>
      selectionRef.current
        ?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
        ?.focus(),
    );
  };
  /**
   * Изменяет включение, сохраняя тексты временно снятых пунктов в форме.
   */
  const handleToggle = (
    featureId: string,
    scenarioId: string | undefined,
    isEnabled: boolean,
  ): void => {
    const nextFeatures = form.getValues().features.map((feature) => {
      if (feature.featureId !== featureId) return feature;
      if (scenarioId === undefined)
        return {
          ...feature,
          isEnabled,
          scenarios: feature.scenarios.map((scenario) => ({
            ...scenario,
            isEnabled: isEnabled && scenario.isEnabled,
          })),
        };
      return {
        ...feature,
        isEnabled: isEnabled || feature.isEnabled,
        scenarios: feature.scenarios.map((scenario) =>
          scenario.scenarioId === scenarioId ? { ...scenario, isEnabled } : scenario,
        ),
      };
    });
    form.setFieldValue("features", nextFeatures);
    if (isEnabled) handleInspect(featureId, scenarioId);
  };
  /**
   * Явно включает все сценарии, независимо от фильтра дерева.
   */
  const handleSelectAll = (featureId: string): void => {
    form.setFieldValue(
      "features",
      form.getValues().features.map((feature) =>
        feature.featureId === featureId
          ? {
              ...feature,
              isEnabled: true,
              scenarios: feature.scenarios.map((scenario) => ({ ...scenario, isEnabled: true })),
            }
          : feature,
      ),
    );
    handleInspect(featureId);
  };
  /**
   * Показывает первое выбранное описание, которое не заполнено.
   */
  const handleInvalid = (errors: typeof form.errors): void => {
    const path = Object.keys(errors)[0];
    if (path === undefined) return;
    const segments = path.split(".");
    const feature = form.getValues().features[Number(segments[1])];
    if (feature === undefined) return;
    const scenarioId =
      segments[2] === "scenarios" ? feature.scenarios[Number(segments[3])]?.scenarioId : undefined;
    handleInspect(feature.featureId, scenarioId);
    setSaveError("Дополните заголовки и описания выбранных вкладов.");
    const inputSelector = path.endsWith(".title") ? "input" : "textarea";
    requestAnimationFrame(() =>
      editorRef.current?.querySelector<HTMLElement>(inputSelector)?.focus(),
    );
  };
  /**
   * Сохраняет только выбранный состав одной операцией, оставляя ввод при отказе.
   */
  const handleSubmit = async (submitted: ScopeFormValues): Promise<void> => {
    setSaveError("");
    try {
      const inputs = submitted.features
        .filter((feature) => feature.isEnabled)
        .map((feature) => ({
          featureId: feature.featureId,
          title: feature.title,
          description: feature.description,
          status: feature.status,
          scenarios: feature.scenarios
            .filter((scenario) => scenario.isEnabled)
            .map(({ scenarioId, title, description, status }) => ({
              scenarioId,
              title,
              description,
              status,
            })),
        }));
      const result = await saveApplicationScope(application.id, inputs, baseRevision);
      if (!result.isSaved) {
        setSaveError(result.message);
        return;
      }
      canLeaveRef.current = true;
      removeSessionStored(draftKey);
      form.resetDirty(submitted);
      setRestoredDraft(false);
      notifications.show({
        position: "top-center",
        autoClose: 2500,
        title: "Состав реализации сохранён",
        message: "Состав реализации сохранён. Общая готовность продукта пересчитана.",
        color: "success",
        closeButtonProps: { "aria-label": "Закрыть уведомление" },
      });
      navigate(backTo, { replace: true });
    } catch {
      setDefect(new Error("Неожиданный сбой редактора состава приложения"));
    }
  };
  /**
   * Отменяет черновик только по явному решению пользователя.
   */
  const handleDiscard = (): void => {
    canLeaveRef.current = true;
    removeSessionStored(draftKey);
    navigate(backTo);
  };
  /**
   * Запрашивает подтверждение отмены изменённого ввода.
   */
  const handleCancel = (): void => {
    if (isDirty) setDiscardOpen(true);
    else handleDiscard();
  };
  /**
   * Применяет сохранённый ввод к актуальному составу каталога после явного выбора.
   */
  const handleKeepDraft = (): void => {
    const nextValues = createScopeValues(features, contributions, form.getValues());
    form.setValues(nextValues);
    setBaseRevision(revision);
    setCanPersist(writeSessionStored(draftKey, { values: nextValues, revision }));
    setSaveError("");
  };
  /**
   * Заменяет черновик подтверждённым составом приложения.
   */
  const handleUseCurrent = (): void => {
    const nextValues = createScopeValues(features, contributions);
    form.setValues(nextValues);
    form.resetDirty(nextValues);
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
      {hasRestoredDraft && <Alert>Восстановлен черновик состава и описаний этой вкладки.</Alert>}
      {hasConflict && (
        <Alert color="warning" title="Данные продукта изменились" role="alert">
          Ваш ввод сохранён. Выберите, с какой версией продолжить.
          <Group gap="xs" mt="sm">
            <Button size="xs" variant="default" onClick={handleKeepDraft}>
              Оставить мой ввод
            </Button>
            <Button size="xs" variant="subtle" onClick={handleUseCurrent}>
              Загрузить актуальную версию
            </Button>
          </Group>
        </Alert>
      )}
      {!canPersist && (
        <Alert color="warning" role="alert">
          Не удалось сохранить черновик в браузере. Сохраните изменения перед закрытием страницы.
        </Alert>
      )}
      <fieldset disabled={form.submitting} className={styles.workspace}>
        <div
          ref={selectionRef}
          className={clsx(styles.selectionPane, isEditing && styles._hiddenOnMobile)}
        >
          <ScopeTree
            items={selectionItems}
            activeFeatureId={target?.featureId}
            activeScenarioId={target?.scenarioId}
            onInspect={handleInspect}
            onToggle={handleToggle}
            onSelectAll={handleSelectAll}
          />
        </div>
        <div
          ref={editorRef}
          className={clsx(styles.editorPane, !isEditing && styles._hiddenOnMobile)}
        >
          {isDefined(editor) && (
            <ScopeEditor
              title={editor.title}
              context={editor.context}
              source={editor.source}
              isEnabled={editor.isEnabled}
              applicationName={application.name}
              fieldKey={`${editor.path}:${form.key(editor.path)}`}
              fieldProps={form.getInputProps(editor.path)}
              titleKey={`${editor.titlePath}:${form.key(editor.titlePath)}`}
              titleProps={form.getInputProps(editor.titlePath)}
              status={editor.status}
              onEnable={() => handleToggle(editor.featureId, editor.scenarioId, true)}
              onBack={handleBackToSelection}
            />
          )}
          {!isDefined(editor) && (
            <StatePanel
              title="Выберите фичу или сценарий"
              description="Здесь появятся исходный контракт и описание вклада приложения."
            />
          )}
        </div>
      </fieldset>
      {hasSaveError && (
        <Alert color="danger" role="alert" title="Не удалось сохранить">
          {saveError}
        </Alert>
      )}
      <footer className={styles.footer}>
        <div>
          <Text size="sm" fw={550}>
            Выбрано фич: {selectedFeatures.length} · Сценариев: {scenarioCount}
          </Text>
          <Text size="xs" c="dimmed" mt={4} role="status">
            {dirtyLabel} · Ctrl/⌘ + Enter
          </Text>
        </div>
        <Group gap="xs">
          <Button variant="default" onClick={handleCancel} disabled={form.submitting}>
            Отмена
          </Button>
          <Button type="submit" loading={form.submitting}>
            Сохранить состав
          </Button>
        </Group>
      </footer>
      <Modal
        opened={isBlocked}
        onClose={() => blocker.reset?.()}
        title="Есть несохранённые изменения"
        closeButtonProps={{ "aria-label": "Остаться в редакторе" }}
        centered
      >
        <Text size="sm">Можно продолжить редактирование или перейти с сохранённым черновиком.</Text>
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
        title="Отменить правки состава?"
        closeButtonProps={{ "aria-label": "Продолжить редактирование" }}
        centered
      >
        <Text size="sm">Несохранённый выбор и описания вкладов будут удалены из черновика.</Text>
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
