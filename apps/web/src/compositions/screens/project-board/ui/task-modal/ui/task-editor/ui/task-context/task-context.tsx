import clsx from "clsx";
import { useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Group,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { ArrowLeft, FileText, Plus, X, Puzzle, Route } from "lucide-react";
import {
  useProductEntities,
  useProductEntity,
  useProductTargetSearch,
  getProductTargetOptions,
  ProductKey,
} from "domains/product";
import { useEntityContext, relationAddress } from "domains/relations";
import { useEntityContent, entityKindLabel } from "domains/entities";
import { useDebouncedValue } from "@mantine/hooks";
import { BoardTaskError, updateBoardTask, useBoardTaskRefresh } from "domains/board-tasks";
import { MarkdownView } from "ui/markdown-view";
import { SectionPanel } from "ui/section-panel";
import { isEmptyArray } from "shared/value-predicates";
import type { TaskContextProps } from "./types/task-context-props.type";
import styles from "./styles/task-context.module.css";

/**
 * Связывает работу с постоянными требованиями продукта.
 *
 * Используется для:
 *  - выбора фич и сценариев в области ответственности доски
 *  - чтения требований и документов без вложенных модальных окон
 */
export const TaskContext = (props: TaskContextProps) => {
  const { projectId, task, board, onOwnRevision, className, ...rootAttrs } = props;
  const [isChoosing, setChoosing] = useState(false);
  const [mode, setMode] = useState<"feature" | "scenario">("feature");
  const [search, setSearch] = useState("");
  const [isContextOpen, setContextOpen] = useState(false);
  const [visibleLinks, setVisibleLinks] = useState(5);
  const [visibleContext, setVisibleContext] = useState(30);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [defect, setDefect] = useState<unknown>();
  const [isRemoving, setRemoving] = useState(false);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [debouncedSearch] = useDebouncedValue(search, 200);
  const isApplicationBoard = board.kind === "application";
  const canChoose =
    board.kind === "product" || (isApplicationBoard && board.applicationId !== null);
  const heading = isApplicationBoard ? "Реализует в приложении" : "Реализует в продукте";
  const emptyText = isApplicationBoard
    ? "Свяжите задачу с реализацией фичи или сценария этого приложения."
    : "Свяжите задачу с фичей или сценарием продукта.";
  const emptySearchText = isApplicationBoard
    ? "Подходящих реализаций нет. Состав приложения задаётся в разделе «Продукт»."
    : "Подходящих целей нет. Фичи и сценарии задаются в разделе «Продукт».";
  const searchPlaceholder = isApplicationBoard
    ? `Ключ или название, например ${board.prefix}-${mode === "feature" ? "FI" : "SI"}-12`
    : `Ключ или название, например ${mode === "feature" ? "FEATURE" : "SCENARIO"}-12`;
  const product = useProductTargetSearch(
    projectId,
    isChoosing && canChoose
      ? {
          kind: isApplicationBoard ? "implementation" : mode,
          q: debouncedSearch,
          active: "true",
          ...(isApplicationBoard && board.applicationId !== null
            ? { application: board.applicationId, implementationTarget: mode }
            : {}),
        }
      : null,
  );
  const context = useEntityContext(projectId, isContextOpen ? selectedId : null);
  const canReadContent =
    isContextOpen &&
    selectedId !== null &&
    documentId !== null &&
    context.data?.nodes.some((node) => relationAddress(node.ref) === documentId) === true;
  const content = useEntityContent(projectId, canReadContent ? documentId : null);
  const details = useProductEntity(projectId, selectedId);
  const refresh = useBoardTaskRefresh(projectId);
  const form = useForm({
    mode: "uncontrolled",
    initialValues: { ids: [] as string[], revision: task.revision },
  });
  const selectedIds = form.useWatchValue("ids");
  const linkRefs = [
    ...new Set([
      ...task.productLinks.map((link) => link.id),
      ...selectedIds,
      ...(selectedId === null ? [] : [selectedId]),
    ]),
  ];
  const linked = useProductEntities(
    projectId,
    isEmptyArray(linkRefs) ? null : { refs: linkRefs, limit: 100 },
  );
  const options = getProductTargetOptions([...product.items, ...(linked.data?.items ?? [])]);
  const candidateItems = getProductTargetOptions(product.items).map((option) => ({
    ...option,
    isSelected: selectedIds.includes(option.id),
  }));
  const linkedItems = task.productLinks.slice(0, visibleLinks).map((link) => {
    const option = options.find((item) => item.id === link.id && item.targetKind === link.kind);
    return {
      ...link,
      key: option?.key,
      title: option?.title ?? link.id,
      path: option?.path ?? "Продуктовая цель недоступна",
      label: option?.kind ?? "Связь",
      Icon: option?.requirementKind === "scenario" ? Route : Puzzle,
      isInactive: option !== undefined && !option.isActive,
    };
  });
  const selectedOption = options.find((item) => item.id === selectedId);
  const detailFields = details.data?.fields;
  const selected =
    selectedOption === undefined
      ? undefined
      : {
          ...selectedOption,
          description:
            detailFields === undefined || detailFields.kind === "scope"
              ? ""
              : detailFields.kind === "document"
                ? detailFields.body
                : detailFields.description,
        };
  const entryItems =
    context.data?.nodes.map((node) => ({
      id: relationAddress(node.ref),
      title: node.title,
      explanation: `${node.key} · ${entityKindLabel(node.ref.kind)}`,
    })) ?? [];
  const visibleEntries = entryItems.slice(0, visibleContext);
  const hasMoreContext = entryItems.length > visibleContext;
  const hasContext = context.data !== undefined;
  const hasContentError = content.error !== undefined;
  const current = canReadContent ? content.data : undefined;
  const hasCurrent = current !== undefined;
  const hasSelection = selectedId !== null;
  const shouldShowMaterials = hasSelection && !isChoosing;
  const hasPreview = selected !== undefined;
  const hasMore = product.hasMore;
  const hasMoreLinks = task.productLinks.length > visibleLinks;
  const isEmpty = isEmptyArray(task.productLinks);
  const linkCount = isEmpty ? undefined : task.productLinks.length;
  const isEmptySearch =
    isEmptyArray(candidateItems) &&
    !product.isLoading &&
    !product.isValidating &&
    product.error === undefined;
  const hasError = error !== "";
  const isBusy = form.submitting || isRemoving;
  const handleSave = async (
    links: typeof task.productLinks,
    revision: number,
  ): Promise<boolean> => {
    setError("");
    const fingerprint = JSON.stringify([links, revision]);
    if (request.current?.fingerprint !== fingerprint)
      request.current = { fingerprint, id: crypto.randomUUID() };
    try {
      const saved = await updateBoardTask(projectId, task.id, {
        productLinks: links,
        ifRevision: revision,
        requestId: request.current.id,
      });
      onOwnRevision(saved.revision);
      await refresh();
      return true;
    } catch (failure) {
      if (failure instanceof BoardTaskError) setError(failure.message);
      else setDefect(failure);
      return false;
    }
  };
  const handleSubmit = async (values: typeof form.values): Promise<void> => {
    const links = values.ids.map((id) => {
      const existing = task.productLinks.find((link) => link.id === id);
      const option = options.find((item) => item.id === id);
      if (existing) return existing;
      if (!option) throw new Error("Выбранная продуктовая цель отсутствует");
      return { id, kind: option.targetKind };
    });
    if (await handleSave(links, values.revision)) {
      setChoosing(false);
      setSelectedId(null);
    }
  };
  const handleChoose = (): void => {
    form.setValues({ ids: task.productLinks.map((link) => link.id), revision: task.revision });
    setChoosing(true);
    requestAnimationFrame(() => {
      searchInput.current?.closest("form")?.scrollIntoView({ block: "start" });
      searchInput.current?.focus({ preventScroll: true });
    });
    setSelectedId(null);
    setError("");
  };
  const handleRemove = async (id: string): Promise<void> => {
    setRemoving(true);
    try {
      await handleSave(
        task.productLinks.filter((link) => link.id !== id),
        task.revision,
      );
    } finally {
      setRemoving(false);
    }
  };
  if (defect !== undefined) throw defect;
  return (
    <SectionPanel
      {...rootAttrs}
      className={clsx(styles.root, className)}
      titleAs="h3"
      title={heading}
      count={linkCount}
      actions={
        <Button
          variant="default"
          leftSection={<Plus size={16} aria-hidden="true" />}
          onClick={handleChoose}
          disabled={isBusy || !canChoose}
        >
          Связать
        </Button>
      }
    >
      {isEmpty && (
        <Text size="sm" c="dimmed">
          {emptyText}
        </Text>
      )}
      <Stack gap="xs" className={styles.links}>
        {linkedItems.map((item) => (
          <Group key={item.id} wrap="nowrap" className={styles.option}>
            <span className={styles.symbol}>
              <item.Icon size={17} aria-hidden="true" />
            </span>
            <UnstyledButton
              flex={1}
              className={styles.target}
              onClick={() => {
                setSelectedId(item.id);
                setDocumentId(null);
                setVisibleContext(30);
              }}
            >
              <Text size="xs" c="dimmed">
                {item.label} · {item.path}
              </Text>
              <Text size="sm" fw={600} mt={4}>
                {item.title}
              </Text>
              <ProductKey value={item.key} />
              {item.isInactive && (
                <Text size="xs" c="warning">
                  Участие приложения снято
                </Text>
              )}
            </UnstyledButton>
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label={`Удалить продуктовую связь ${item.title}`}
              disabled={isBusy || isChoosing}
              onClick={() => void handleRemove(item.id)}
            >
              <X size={16} aria-hidden="true" />
            </ActionIcon>
          </Group>
        ))}
      </Stack>
      {hasMoreLinks && (
        <Button variant="subtle" size="xs" onClick={() => setVisibleLinks(visibleLinks + 10)}>
          Ещё связи с продуктом
        </Button>
      )}
      {isChoosing && (
        <form onSubmit={form.onSubmit(handleSubmit)} className={styles.chooser}>
          <Stack gap="md">
            <SegmentedControl
              value={mode}
              disabled={isBusy}
              onChange={(value) => {
                if (value === "feature" || value === "scenario") setMode(value);
              }}
              data={[
                { value: "feature", label: "Фичи" },
                { value: "scenario", label: "Сценарии" },
              ]}
            />
            <TextInput
              ref={searchInput}
              label="Найти фичу или сценарий"
              placeholder={searchPlaceholder}
              disabled={isBusy}
              value={search}
              onChange={(event) => {
                setSearch(event.currentTarget.value);
              }}
            />
            {product.isLoading && (
              <Text role="status" size="sm" c="dimmed">
                Ищем продуктовые цели…
              </Text>
            )}
            {isEmptySearch && (
              <Text c="dimmed" size="sm">
                {emptySearchText}
              </Text>
            )}
            <div className={styles.picker}>
              <Stack gap="sm" className={styles.results}>
                {candidateItems.map((item) => (
                  <Group key={item.id} wrap="nowrap" className={styles.option}>
                    <Checkbox
                      aria-label={`Выбрать ${item.title}`}
                      checked={item.isSelected}
                      disabled={isBusy}
                      onChange={(event) =>
                        form.setFieldValue(
                          "ids",
                          event.currentTarget.checked
                            ? [...selectedIds, item.id]
                            : selectedIds.filter((id) => id !== item.id),
                        )
                      }
                    />
                    <UnstyledButton
                      flex={1}
                      onClick={() => {
                        setSelectedId(item.id);
                        setDocumentId(null);
                        setVisibleContext(30);
                      }}
                    >
                      <Text size="sm" fw={600}>
                        {item.title}
                      </Text>
                      <ProductKey value={item.key} />
                      <Text size="xs" c="dimmed">
                        {item.kind} · {item.path}
                      </Text>
                    </UnstyledButton>
                  </Group>
                ))}
              </Stack>
              <div className={styles.preview}>
                {!hasPreview && (
                  <Stack gap="sm">
                    <FileText size={24} aria-hidden="true" className={styles.previewIcon} />
                    <Text size="sm" fw={500}>
                      Сначала прочитайте требования
                    </Text>
                    <Text size="xs" c="dimmed">
                      Нажмите на название цели. Отметьте подходящие фичи и сценарии, затем сохраните
                      связи.
                    </Text>
                  </Stack>
                )}
                {hasPreview && (
                  <Stack gap="sm">
                    <Text size="xs" c="dimmed">
                      {selected.path}
                    </Text>
                    <Text fw={600} size="sm">
                      {selected.title}
                    </Text>
                    <ProductKey value={selected.key} />
                    {details.isLoading && (
                      <Text size="sm" role="status">
                        Загружаем описание…
                      </Text>
                    )}
                    <MarkdownView
                      text={selected.description}
                      emptyText="Описание пока не заполнено."
                    />
                  </Stack>
                )}
              </div>
            </div>
            {hasMore && (
              <Button
                variant="subtle"
                loading={product.isValidating}
                onClick={() => void product.setSize(product.size + 1)}
              >
                Показать ещё цели
              </Button>
            )}
            <Group justify="space-between">
              <Text size="xs" c="dimmed">
                Выбрано: {selectedIds.length}
              </Text>
              <Group gap="xs">
                <Button
                  variant="subtle"
                  onClick={() => {
                    setChoosing(false);
                    setSelectedId(null);
                  }}
                  disabled={isBusy}
                >
                  Отмена
                </Button>
                <Button type="submit" loading={form.submitting}>
                  Сохранить связи
                </Button>
              </Group>
            </Group>
          </Stack>
        </form>
      )}
      {hasError && (
        <Alert color="danger" title="Связи не сохранены">
          {error}
        </Alert>
      )}
      {product.error !== undefined && (
        <Alert color="danger">
          Продукт недоступен.{" "}
          <Button variant="subtle" onClick={() => void product.mutate().catch(() => undefined)}>
            Повторить
          </Button>
        </Alert>
      )}
      {linked.error !== undefined && (
        <Alert color="danger">
          Не удалось прочитать сведения о связях.{" "}
          <Button variant="subtle" onClick={() => void linked.mutate()}>
            Повторить
          </Button>
        </Alert>
      )}
      {details.error !== undefined && (
        <Alert color="danger">
          Описание недоступно.{" "}
          <Button variant="subtle" onClick={() => void details.mutate()}>
            Повторить
          </Button>
        </Alert>
      )}
      {shouldShowMaterials && (
        <section className={styles.chooser}>
          <Group justify="space-between" mb="md">
            <Text fw={600}>{selected?.title ?? "Материалы контекста"}</Text>
            <ActionIcon
              aria-label="Закрыть материалы"
              variant="subtle"
              onClick={() => setSelectedId(null)}
            >
              <X size={16} aria-hidden="true" />
            </ActionIcon>
          </Group>
          {context.isLoading && <Text role="status">Загружаем требования…</Text>}
          {context.error !== undefined && (
            <Alert color="danger">
              {context.error.message}{" "}
              <Button variant="subtle" onClick={() => void context.mutate().catch(() => undefined)}>
                Повторить
              </Button>
            </Alert>
          )}
          {selected !== undefined && (
            <MarkdownView
              text={selected.description}
              emptyText="Описание цели пока не заполнено."
            />
          )}
          {!isContextOpen && (
            <Button variant="subtle" size="sm" mt="sm" onClick={() => setContextOpen(true)}>
              Показать полный контекст
            </Button>
          )}
          <Stack gap="xs" mt="md">
            {hasContext && (
              <Text size="xs" c="dimmed">
                Контекст загружен полностью. Сущностей: {entryItems.length}; связей:{" "}
                {context.data?.edges.length}. Показано сущностей: {visibleEntries.length}.
              </Text>
            )}
            {visibleEntries.map((entry) => (
              <UnstyledButton
                key={entry.id}
                className={styles.option}
                onClick={() => setDocumentId(entry.id)}
              >
                <Group gap="xs">
                  <FileText size={16} aria-hidden="true" />
                  <Text size="sm" fw={500}>
                    {entry.title}
                  </Text>
                </Group>
                <Text size="xs" c="dimmed">
                  {entry.explanation}
                </Text>
              </UnstyledButton>
            ))}
          </Stack>
          {hasMoreContext && (
            <Button variant="subtle" onClick={() => setVisibleContext(visibleContext + 30)}>
              Показать ещё сущности
            </Button>
          )}
          {content.isLoading && (
            <Text role="status">Загружаем полный текст выбранной сущности…</Text>
          )}
          {hasContentError && (
            <Alert color="danger" mt="sm">
              {content.error?.message}
              <Button variant="subtle" onClick={() => void content.mutate()}>
                Повторить
              </Button>
            </Alert>
          )}
          {hasCurrent && (
            <Stack gap="md" mt="md">
              <Button
                variant="subtle"
                leftSection={<ArrowLeft size={16} aria-hidden="true" />}
                onClick={() => setDocumentId(null)}
              >
                Свернуть материал
              </Button>
              <Text fw={600}>{current.title}</Text>
              <MarkdownView text={current.markdown} emptyText="У сущности нет полного описания." />
            </Stack>
          )}
        </section>
      )}
    </SectionPanel>
  );
};
