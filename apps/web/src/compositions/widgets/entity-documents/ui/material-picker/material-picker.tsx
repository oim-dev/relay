import { useRef, useState } from "react";
import { Alert, Button, Checkbox, Loader, Modal, Radio, Skeleton, Textarea } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useDebouncedValue, useMediaQuery, useWindowEvent } from "@mantine/hooks";
import { ArrowLeft } from "lucide-react";
import {
  DOCUMENT_KIND_OPTIONS,
  DOCUMENT_RELATION_TYPES,
  DOCUMENT_RELATION_TYPE_OPTIONS,
  MATERIAL_FORMAT_OPTIONS,
  useEntityMaterialRelations,
  useLibrarySettings,
  useMaterialCatalog,
  useMaterialFacets,
  useMaterialMutations,
} from "domains/documents";
import type { DocumentEntity, DocumentRelation, MaterialCatalogFilters } from "domains/documents";
import { useProjectId } from "domains/project";
import { isDefined, isEmptyArray, isNonEmptyArray } from "shared/value-predicates";
import { toFailedOutcome } from "./helpers/attach-outcome";
import { PickerFilters } from "./ui/picker-filters/picker-filters";
import { PickerOption } from "./ui/picker-option/picker-option";
import { PickerResults } from "./ui/picker-results/picker-results";
import type { AttachOutcome } from "./types/attach-outcome.type";
import type { MaterialPickerProps } from "./types/material-picker-props.type";
import styles from "./styles/material-picker.module.css";

/** Тип связи. */
type RelationType = DocumentRelation["type"];
/** Условия поиска в окне. */
type PickerQuery = { query: string; section: string; kind: string; format: string };
/** Значения прикрепления, общие для всех выбранных материалов. */
type AttachValues = { type: RelationType; description: string };

/** Начальные условия: вся библиотека без архива. */
const INITIAL_QUERY: PickerQuery = { query: "", section: "", kind: "", format: "" };
/** Предел пояснения связи из контракта. */
const DESCRIPTION_LIMIT = 16 * 1024;

/** Подпись варианта со счётчиком сервера. */
const withCount = (label: string, count: number | undefined): string =>
  isDefined(count) ? `${label} · ${count}` : label;

/**
 * Единый выборщик библиотеки: поиск и фильтры по серверному каталогу, предпросмотр,
 * множественный выбор и прикрепление выбранных материалов к сущности одним типом связи
 * и общим пояснением. Каждый материал прикрепляется отдельной записью под своей ревизией,
 * итог показывается по каждому, автоматических повторов нет.
 *
 * Используется для:
 *  - действия «Добавить из библиотеки» блока «Материалы»
 */
export const MaterialPicker = (props: MaterialPickerProps) => {
  const { opened, target, targetLabel, onClose, onExited, onAttached, renderPreview } = props;
  const projectId = useProjectId();
  const isMobile = useMediaQuery("(max-width: 47.99em)");
  const { relate } = useMaterialMutations(projectId);
  const [filters, setFilters] = useState<PickerQuery>(INITIAL_QUERY);
  const [search] = useDebouncedValue(filters.query, 250);
  const [pages, setPages] = useState(1);
  const [selected, setSelected] = useState<Map<string, DocumentEntity>>(new Map());
  const [outcomes, setOutcomes] = useState<AttachOutcome[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [isSubmitting, setSubmitting] = useState(false);
  const [defect, setDefect] = useState<unknown>();
  const previewTriggers = useRef(new Map<string, HTMLButtonElement | null>());
  const backRef = useRef<HTMLButtonElement>(null);
  const form = useForm<AttachValues>({
    mode: "controlled",
    initialValues: { type: "references", description: "" },
    validate: {
      description: (value) =>
        value.length > DESCRIPTION_LIMIT ? "Пояснение длиннее 16 384 символов" : null,
    },
  });
  const catalogFilters: MaterialCatalogFilters = {
    q: search.trim(),
    view: filters.section === "none" ? "none" : "all",
    section: filters.section === "" || filters.section === "none" ? null : filters.section,
    kind: DOCUMENT_KIND_OPTIONS.find((option) => option.value === filters.kind)?.value ?? null,
    target: null,
    sort: "title",
    format:
      MATERIAL_FORMAT_OPTIONS.find((option) => option.value === filters.format)?.value ?? null,
  };
  const catalog = useMaterialCatalog(projectId, catalogFilters, opened ? pages : 1);
  const facets = useMaterialFacets(projectId, opened ? catalogFilters : null);
  const settings = useLibrarySettings(projectId);
  const attachments = useEntityMaterialRelations(
    projectId,
    opened ? `${target.kind}:${target.id}` : null,
  );
  const attachedTypes = attachments.data;
  const hasAttachmentsError = isDefined(attachments.error);
  const isAttachmentsKnown = isDefined(attachedTypes) && !hasAttachmentsError;
  const isCheckingAttachments = !isDefined(attachedTypes) && !hasAttachmentsError;
  const sectionNames = new Map(
    (settings.data?.sections ?? []).map((section) => [section.id, section.name]),
  );
  const facetsData = facets.data;
  const sectionOptions = [
    { value: "", label: "Все разделы" },
    ...(facetsData?.sections ?? []).map((item) => ({
      value: item.sectionId ?? "none",
      label: withCount(
        item.sectionId === null ? "Без раздела" : (sectionNames.get(item.sectionId) ?? "Раздел"),
        item.count,
      ),
    })),
  ];
  const kindOptions = [
    { value: "", label: "Все типы" },
    ...DOCUMENT_KIND_OPTIONS.map((option) => ({
      value: option.value,
      label: withCount(
        option.label,
        facetsData?.kinds.find((item) => item.kind === option.value)?.count,
      ),
    })),
  ];
  const formatOptions = [
    { value: "", label: "Все форматы" },
    ...MATERIAL_FORMAT_OPTIONS.map((option) => ({
      value: option.value,
      label: withCount(
        option.label,
        facetsData?.formats.find((item) => item.format === option.value)?.count,
      ),
    })),
  ];
  const catalogPages = catalog.data ?? [];
  const materialList = catalogPages.flatMap((page) => page.items);
  const lastPage = catalogPages.at(-1);
  const total = catalogPages[0]?.total ?? 0;
  const chosenType = form.values.type;
  /** Существующие связи материала; пустой список только для полностью прочитанного набора. */
  const typesOf = (materialId: string): RelationType[] =>
    isAttachmentsKnown ? (attachedTypes?.[materialId] ?? []) : [];
  const optionItems = materialList.map((material) => {
    const types = typesOf(material.ref.id);
    return {
      material,
      sectionName:
        material.document?.sectionId === null || !isDefined(material.document)
          ? "Без раздела"
          : (sectionNames.get(material.document.sectionId) ?? "Без раздела"),
      attachedLabels: types.map((type) => DOCUMENT_RELATION_TYPES[type]),
      isSelected: selected.has(material.ref.id),
      isLocked: types.includes(chosenType),
    };
  });
  const selectedList = [...selected.values()];
  /** Выбранные, у которых связь выбранного типа уже есть: не отправляются, выбор сохраняется. */
  const lockedCount = selectedList.filter((material) =>
    typesOf(material.ref.id).includes(chosenType),
  ).length;
  const attachList = selectedList.filter(
    (material) => !typesOf(material.ref.id).includes(chosenType),
  );
  const selectedCount = attachList.length;
  const lockedLabel = `Уже прикреплены как «${DOCUMENT_RELATION_TYPES[chosenType]}» и не будут отправлены: ${lockedCount}`;
  const isFirstLoading = !isDefined(catalog.data) && !isDefined(catalog.error);
  const hasCatalogError = isDefined(catalog.error);
  const isEmpty = isDefined(catalog.data) && isEmptyArray(materialList);
  const hasMore = isDefined(lastPage) && lastPage.nextOffset !== null;
  const isLoadingMore = catalog.isValidating && catalog.size < pages;
  const hasOutcomes = isNonEmptyArray(outcomes);
  const isPreviewing = previewId !== null;
  const previewItem = optionItems.find((item) => item.material.ref.id === previewId);
  const previewTitle =
    materialList.find((material) => material.ref.id === previewId)?.title ??
    selected.get(previewId ?? "")?.title ??
    "Материал";
  const submitLabel = `Прикрепить · ${selectedCount}`;
  const resultLabel = `Найдено: ${total}`;
  /** Меняет условие поиска и сбрасывает показанный объём. */
  const handleFilter = (name: keyof PickerQuery, value: string): void => {
    setFilters((current) => ({ ...current, [name]: value }));
    setPages(1);
  };
  /** Добавляет или убирает материал из выбора. */
  const handleToggle = (material: DocumentEntity, checked: boolean): void => {
    setSelected((current) => {
      const next = new Map(current);
      if (checked) next.set(material.ref.id, material);
      else next.delete(material.ref.id);
      return next;
    });
  };
  /** Сбрасывает окно к начальному состоянию и закрывает его. */
  const resetAndClose = (): void => {
    setFilters(INITIAL_QUERY);
    setPages(1);
    setSelected(new Map());
    setOutcomes([]);
    setPreviewId(null);
    form.reset();
    onClose();
  };
  /** Закрывает окно и отбрасывает несохранённый выбор; во время записи недоступно. */
  const handleClose = (): void => {
    if (!isSubmitting) resetAndClose();
  };
  /** Открывает предпросмотр внутри окна и переводит фокус к возврату. */
  const handlePreview = (id: string): void => {
    setPreviewId(id);
    requestAnimationFrame(() => backRef.current?.focus());
  };
  /** Возвращает к списку и фокус к кнопке предпросмотра. */
  const handlePreviewBack = (): void => {
    const id = previewId;
    setPreviewId(null);
    requestAnimationFrame(() => {
      if (id !== null) previewTriggers.current.get(id)?.focus();
    });
  };
  /** Прикрепляет выбранные материалы по одному; итог — по каждому, без повторов. */
  const handleAttach = async (values: AttachValues): Promise<void> => {
    setSubmitting(true);
    setOutcomes([]);
    const results: AttachOutcome[] = [];
    try {
      for (const material of attachList) {
        const entry = { id: material.ref.id, title: material.title };
        try {
          await relate(
            { id: material.ref.id, revision: material.revision },
            {
              action: "attach",
              target,
              type: values.type,
              description: values.description,
            },
            crypto.randomUUID(),
          );
          results.push({ ...entry, status: "applied", message: "Прикреплён." });
        } catch (failure) {
          const outcome = toFailedOutcome(entry, failure);
          if (!isDefined(outcome)) throw failure;
          results.push(outcome);
        }
      }
    } catch (failure) {
      setDefect(failure);
      return;
    } finally {
      setSubmitting(false);
    }
    const appliedCount = results.filter((result) => result.status === "applied").length;
    if (appliedCount > 0) onAttached(appliedCount);
    const isComplete = results.every((result) => result.status === "applied");
    if (isComplete) {
      resetAndClose();
      return;
    }
    setOutcomes(results);
    setSelected((current) => {
      const next = new Map(current);
      results
        .filter((result) => result.status !== "error")
        .forEach((result) => next.delete(result.id));
      return next;
    });
  };
  useWindowEvent("keydown", (event) => {
    if (event.key === "Escape" && isPreviewing) handlePreviewBack();
  });
  if (isDefined(defect)) throw defect;
  return (
    <Modal.Root
      opened={opened}
      onClose={handleClose}
      onExitTransitionEnd={onExited}
      size="xl"
      centered
      fullScreen={isMobile === true}
      closeOnEscape={!isPreviewing && !isSubmitting}
      closeOnClickOutside={!isSubmitting}
    >
      <Modal.Overlay />
      <Modal.Content className={styles.content}>
        <Modal.Header className={styles.header}>
          <div className={styles.titleGroup}>
            <Modal.Title className={styles.title}>Добавить из библиотеки</Modal.Title>
            <p className={styles.subtitle}>Прикрепить к: {targetLabel}</p>
          </div>
          <Modal.CloseButton aria-label="Закрыть выбор материалов" disabled={isSubmitting} />
        </Modal.Header>
        <Modal.Body className={styles.body}>
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.stopPropagation();
              form.onSubmit(handleAttach)(event);
            }}
          >
            {isPreviewing && (
              <section className={styles.preview} aria-label={`Предпросмотр: ${previewTitle}`}>
                <div className={styles.previewHead}>
                  <Button
                    ref={backRef}
                    variant="subtle"
                    color="gray"
                    size="xs"
                    leftSection={<ArrowLeft size={14} aria-hidden="true" />}
                    onClick={handlePreviewBack}
                  >
                    К списку
                  </Button>
                  <h3 className={styles.previewTitle}>{previewTitle}</h3>
                  {isDefined(previewItem) && (
                    <Checkbox
                      label="Выбрать для прикрепления"
                      checked={previewItem.isSelected || previewItem.isLocked}
                      disabled={previewItem.isLocked || isSubmitting || !isAttachmentsKnown}
                      onChange={(event) =>
                        handleToggle(previewItem.material, event.currentTarget.checked)
                      }
                    />
                  )}
                </div>
                {renderPreview(previewId)}
              </section>
            )}
            <div className={styles.browse} hidden={isPreviewing}>
              <PickerFilters
                query={filters.query}
                section={filters.section}
                kind={filters.kind}
                format={filters.format}
                sectionOptions={sectionOptions}
                kindOptions={kindOptions}
                formatOptions={formatOptions}
                onChange={handleFilter}
              />
              <p className={styles.found} aria-live="polite">
                {resultLabel}. Архивные материалы не предлагаются.
              </p>
              {hasCatalogError && (
                <Alert color="orange" title="Не удалось прочитать библиотеку">
                  {catalog.error?.message}
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={() => void catalog.mutate().catch(() => undefined)}
                  >
                    Повторить чтение
                  </Button>
                </Alert>
              )}
              {isCheckingAttachments && (
                <p className={styles.status} role="status">
                  <Loader size={14} aria-hidden="true" />
                  Проверяем, что уже прикреплено. До проверки выбор недоступен.
                </p>
              )}
              {hasAttachmentsError && (
                <Alert color="orange" title="Не удалось проверить прикрепления">
                  Связи материалов с этой записью не прочитаны. Выбор недоступен, пока не известно,
                  что уже прикреплено.
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={() => void attachments.mutate().catch(() => undefined)}
                  >
                    Проверить снова
                  </Button>
                </Alert>
              )}
              {isFirstLoading && (
                <div className={styles.loading} aria-label="Читаем библиотеку">
                  <Skeleton height={56} radius="md" />
                  <Skeleton height={56} radius="md" />
                  <Skeleton height={56} radius="md" />
                </div>
              )}
              {isEmpty && (
                <p className={styles.empty}>
                  Ничего не найдено. Измените поиск или сбросьте фильтры — либо создайте новый
                  материал.
                </p>
              )}
              <fieldset className={styles.options} disabled={isSubmitting}>
                <legend className={styles.legend}>Материалы библиотеки</legend>
                {optionItems.map((item) => (
                  <PickerOption
                    key={item.material.ref.id}
                    material={item.material}
                    sectionName={item.sectionName}
                    attachedLabels={item.attachedLabels}
                    isSelected={item.isSelected}
                    isLocked={item.isLocked}
                    isDisabled={isSubmitting || !isAttachmentsKnown}
                    previewRef={(node) => {
                      previewTriggers.current.set(item.material.ref.id, node);
                    }}
                    onToggle={(checked) => handleToggle(item.material, checked)}
                    onPreview={() => handlePreview(item.material.ref.id)}
                  />
                ))}
              </fieldset>
              {hasMore && (
                <Button
                  variant="subtle"
                  color="gray"
                  size="xs"
                  loading={isLoadingMore}
                  className={styles.more}
                  onClick={() => setPages(pages + 1)}
                >
                  Показать ещё
                </Button>
              )}
            </div>
            <div className={styles.footer}>
              {hasOutcomes && <PickerResults outcomes={outcomes} />}
              {lockedCount > 0 && <p className={styles.locked}>{lockedLabel}</p>}
              <Radio.Group label="Тип связи" size="xs" {...form.getInputProps("type")}>
                <div className={styles.types}>
                  {DOCUMENT_RELATION_TYPE_OPTIONS.map((option) => (
                    <Radio
                      key={option.value}
                      value={option.value}
                      label={option.label}
                      disabled={isSubmitting}
                    />
                  ))}
                </div>
              </Radio.Group>
              <Textarea
                label="Зачем нужны эти материалы здесь"
                description="Необязательно. Одно пояснение для всех выбранных; позже его можно изменить у каждой связи."
                autosize
                minRows={1}
                maxRows={4}
                size="xs"
                disabled={isSubmitting}
                {...form.getInputProps("description")}
              />
              <div className={styles.actions}>
                <Button
                  type="submit"
                  size="sm"
                  loading={isSubmitting}
                  disabled={selectedCount === 0 || !isAttachmentsKnown}
                >
                  {submitLabel}
                </Button>
                <Button
                  size="sm"
                  variant="default"
                  disabled={isSubmitting || selected.size === 0}
                  onClick={() => setSelected(new Map())}
                >
                  Снять выбор
                </Button>
              </div>
            </div>
          </form>
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
};
