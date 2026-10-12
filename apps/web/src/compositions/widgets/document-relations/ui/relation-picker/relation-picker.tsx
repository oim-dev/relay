import { useState } from "react";
import { useForm } from "@mantine/form";
import { useDebouncedValue } from "@mantine/hooks";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Select,
  Text,
  Textarea,
  TextInput,
  ActionIcon,
  ScrollArea,
} from "@mantine/core";
import { Search, X, Link2 } from "lucide-react";
import { useEntities, entityKindLabel } from "domains/entities";
import type { EntityKind } from "domains/entities";
import { useProjectId } from "domains/project";
import { DocumentAccessError } from "domains/documents";
import type { DocumentRelation } from "domains/documents";
import { isEmptyArray } from "shared/value-predicates";
import type { RelationPickerProps } from "./types/relation-picker-props.type";
import styles from "./styles/relation-picker.module.css";

/** Допустимые виды остаются доступны без длинной полосы табов. */
const KINDS: EntityKind[] = [
  "task",
  "feature",
  "scenario",
  "application",
  "implementation",
  "product",
  "project",
  "board",
  "document",
];

/**
 * Выбирает несколько реальных сущностей и поясняет назначение каждой привязки.
 *
 * Используется для:
 *  - поиска по проекту без потери скрытого выбора
 *  - явного применения или отмены набора отношений
 */
export const RelationPicker = ({
  initial,
  documentId,
  isDraft,
  onApply,
  onClose,
}: RelationPickerProps) => {
  const projectId = useProjectId();
  const [query, setQuery] = useState("");
  const [search] = useDebouncedValue(query, 200);
  const [kind, setKind] = useState<string | null>(null);
  const [page, setPage] = useState<{ offset: number; version?: string }>({ offset: 0 });
  const [error, setError] = useState("");
  const [defect, setDefect] = useState<Error>();
  const [isSelectionVisible, setSelectionVisible] = useState(false);
  const form = useForm<{ links: DocumentRelation[] }>({
    mode: "uncontrolled",
    initialValues: { links: initial },
  });
  const links = form.useWatchValue("links");
  const selectedRefs = [...new Set(links.map((link) => `${link.target.kind}:${link.target.id}`))];
  const selectedQuery = useEntities(projectId, { refs: selectedRefs, limit: 100 });
  const selectedKind = KINDS.find((entry) => entry === kind);
  const response = useEntities(projectId, {
    q: search,
    ...(selectedKind ? { kind: selectedKind } : {}),
    ...page,
    limit: 40,
  });
  const optionItems = (response.data?.items ?? [])
    .filter((entry) => entry.ref.id !== documentId)
    .map((entry) => ({
      ...entry,
      address: `${entry.ref.kind}:${entry.ref.id}`,
      isSelected: links.some(
        (link) => link.target.kind === entry.ref.kind && link.target.id === entry.ref.id,
      ),
      kindLabel: entityKindLabel(entry.ref.kind),
      hasContext: entry.context !== undefined,
      isDraftDocument: entry.document?.status === "draft",
    }));
  const selectedItems = links.map((link, index) => {
    const entry = selectedQuery.data?.items.find(
      (item) => item.ref.kind === link.target.kind && item.ref.id === link.target.id,
    );
    return {
      ...link,
      index,
      address: `${link.target.kind}:${link.target.id}:${link.type}`,
      title: entry?.title ?? link.target.id,
      key: entry?.key ?? link.target.id,
      kindLabel: entityKindLabel(link.target.kind),
    };
  });
  const hasNoOptions = isEmptyArray(optionItems) && !response.isLoading && !response.error;
  const hasSelection = !isEmptyArray(links);
  const hasMore = response.data?.nextOffset !== null && response.data?.nextOffset !== undefined;
  const hasPrevious = page.offset > 0;
  const hasError = error !== "";
  const hasLoadError = response.error !== undefined;
  // Отказ чтения без данных не выдаётся за пустой результат.
  const foundLabel = `Найдено: ${response.data?.total ?? (hasLoadError ? "—" : 0)}`;
  const applyLabel = isDraft ? "Применить к документу" : "Сохранить прикрепления";
  const hasLimit = links.length >= 100;
  /** Переключает одну цель независимо от её родителей и соседей. */
  const handleToggle = (target: DocumentRelation["target"], isSelected: boolean): void => {
    if (isSelected)
      form.setFieldValue(
        "links",
        form
          .getValues()
          .links.filter((link) => link.target.id !== target.id || link.target.kind !== target.kind),
      );
    else if (!hasLimit)
      form.insertListItem("links", { target, type: "references", description: "" });
  };
  /** Закрывает диалог только после подтверждённого применения. */
  const handleSubmit = async ({ links }: { links: DocumentRelation[] }): Promise<void> => {
    setError("");
    try {
      await onApply(links);
      onClose();
    } catch (failure) {
      if (failure instanceof DocumentAccessError) setError(failure.message);
      else
        setDefect(
          failure instanceof Error ? failure : new Error("Не удалось сохранить прикрепления"),
        );
    }
  };
  if (defect) throw defect;
  return (
    <form
      className={styles.root}
      onSubmit={(event) => {
        event.stopPropagation();
        form.onSubmit(handleSubmit)(event);
      }}
    >
      <Text size="sm" c="dimmed" mb="md">
        Выберите сущности, к которым нужно прикрепить документ. Выбор родителя не выбирает дочерние
        элементы.
      </Text>
      <fieldset className={styles.fields} disabled={form.submitting}>
        <div className={styles.search}>
          <TextInput
            aria-label="Поиск сущностей"
            placeholder="Название или ключ…"
            leftSection={<Search size={16} />}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setPage({ offset: 0 });
            }}
          />
          <Select
            aria-label="Вид сущности"
            placeholder="Все сущности"
            clearable
            value={kind}
            data={KINDS.map((value) => ({ value, label: entityKindLabel(value) }))}
            onChange={(value) => {
              setKind(value);
              setPage({ offset: 0 });
            }}
          />
        </div>
        {hasLoadError && (
          <Alert color="orange">
            {response.error?.message}
            <Button
              variant="subtle"
              size="xs"
              onClick={() => {
                setPage({ offset: 0 });
                void response.mutate();
              }}
            >
              Повторить
            </Button>
          </Alert>
        )}
        <ScrollArea.Autosize mah={320} type="auto" mt="sm">
          <div className={styles.options}>
            {optionItems.map((entry) => (
              <Checkbox
                key={entry.address}
                className={styles.option}
                checked={entry.isSelected}
                disabled={!entry.isSelected && (!entry.active || hasLimit)}
                onChange={() => handleToggle(entry.ref, entry.isSelected)}
                label={
                  <span className={styles.optionLabel}>
                    <span className={styles.optionTitle}>
                      {entry.title}
                      {entry.isDraftDocument && (
                        <Badge
                          size="xs"
                          color="yellow"
                          c="var(--tasks-warning-ink)"
                          variant="light"
                          tt="none"
                        >
                          Черновик
                        </Badge>
                      )}
                    </span>
                    <span className={styles.optionMeta}>
                      {entry.key} · {entry.kindLabel}
                    </span>
                    {entry.hasContext && <span className={styles.optionMeta}>{entry.context}</span>}
                  </span>
                }
              />
            ))}
            {hasNoOptions && (
              <Text size="sm" c="dimmed" ta="center" py="xl">
                Совпадений пока нет
              </Text>
            )}
          </div>
        </ScrollArea.Autosize>
        <Group justify="space-between" mt="xs">
          <Button
            variant="subtle"
            size="compact-xs"
            disabled={!hasPrevious}
            onClick={() =>
              setPage({ offset: Math.max(0, page.offset - 40), version: response.data?.version })
            }
          >
            Назад
          </Button>
          <Text size="xs" c="dimmed">
            {foundLabel}
          </Text>
          <Button
            variant="subtle"
            size="compact-xs"
            disabled={!hasMore}
            onClick={() =>
              setPage({ offset: response.data?.nextOffset ?? 0, version: response.data?.version })
            }
          >
            Ещё варианты
          </Button>
        </Group>
        <div className={styles.selectionHeading}>
          <Text size="sm" fw={600}>
            Выбрано {links.length}
          </Text>
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            disabled={!hasSelection}
            onClick={() => setSelectionVisible(!isSelectionVisible)}
          >
            Назначение и пояснения
          </Button>
        </div>
        {isSelectionVisible && (
          <ScrollArea.Autosize mah={280} type="auto">
            {selectedItems.map((entry) => (
              <div key={entry.address} className={styles.selected}>
                <Group justify="space-between" wrap="nowrap">
                  <Text size="sm" fw={500}>
                    {entry.title}
                  </Text>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    aria-label={`Убрать прикрепление: ${entry.title}`}
                    onClick={() => form.removeListItem("links", entry.index)}
                  >
                    <X size={15} />
                  </ActionIcon>
                </Group>
                <Text size="xs" c="dimmed" mb="xs">
                  {entry.kindLabel} · {entry.key}
                </Text>
                <Select
                  label="Назначение прикрепления"
                  size="xs"
                  key={form.key(`links.${entry.index}.type`)}
                  data={[
                    { value: "references", label: "Для чтения — полезно при работе" },
                    { value: "documents", label: "Описывает эту сущность" },
                  ]}
                  {...form.getInputProps(`links.${entry.index}.type`)}
                />
                <Textarea
                  label="Когда и зачем читать"
                  description="Необязательно · Markdown"
                  size="xs"
                  autosize
                  minRows={2}
                  mt="xs"
                  key={form.key(`links.${entry.index}.description`)}
                  {...form.getInputProps(`links.${entry.index}.description`)}
                />
              </div>
            ))}
          </ScrollArea.Autosize>
        )}
        {hasLimit && (
          <Text size="xs" c="dimmed">
            Не более 100 прикреплений у документа.
          </Text>
        )}
      </fieldset>
      {hasError && (
        <Alert color="red" mt="sm">
          {error}
        </Alert>
      )}
      <footer className={styles.footer}>
        <Text size="xs" c="dimmed">
          <Link2 size={12} aria-hidden="true" /> Прикрепление не меняет статус сущностей
        </Text>
        <Group gap="xs">
          <Button variant="default" onClick={onClose} disabled={form.submitting}>
            Отмена
          </Button>
          <Button type="submit" loading={form.submitting}>
            {applyLabel}
          </Button>
        </Group>
      </footer>
    </form>
  );
};
