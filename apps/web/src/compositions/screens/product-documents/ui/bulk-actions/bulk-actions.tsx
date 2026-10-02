import { useState } from "react";
import clsx from "clsx";
import { ActionIcon, Button, Menu, Modal, Popover } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { ChevronDown, FolderInput, MoreHorizontal, Tag, TagsIcon, X } from "lucide-react";
import { isEmptyArray } from "shared/value-predicates";
import { BulkTagsForm } from "./ui/bulk-tags-form/bulk-tags-form";
import type { BulkActionsProps } from "./types/bulk-actions-props.type";
import styles from "./styles/bulk-actions.module.css";

/** Изменения состояния и закрепления для выбранных материалов. */
const STATE_ACTIONS = [
  { key: "pin", label: "Закрепить", operation: { type: "pin", pinned: true } },
  { key: "unpin", label: "Открепить", operation: { type: "pin", pinned: false } },
  {
    key: "active",
    label: "Сделать действующими",
    operation: { type: "setStatus", documentStatus: "active" },
  },
  {
    key: "draft",
    label: "Вернуть в черновики",
    operation: { type: "setStatus", documentStatus: "draft" },
  },
  {
    key: "archived",
    label: "Перенести в архив",
    operation: { type: "setStatus", documentStatus: "archived" },
  },
] as const;

/**
 * Применяет одно действие ко всем выбранным материалам: раздел, теги, состояние, закрепление.
 * На телефоне панель занимает одну строку: счётчик, меню действий и снятие выбора.
 *
 * Используется для:
 *  - упорядочивания нескольких материалов каталога за один шаг
 */
export const BulkActions = (props: BulkActionsProps) => {
  const {
    projectId,
    count,
    isOverLimit,
    isRunning,
    sections,
    selectedTags,
    onRun,
    onClear,
    className,
    ...rootAttrs
  } = props;
  const isWide = useMediaQuery("(min-width: 48em)", true, { getInitialValueInEffect: false });
  const [tagsMode, setTagsMode] = useState<"addTags" | "removeTags" | null>(null);
  const isDisabled = isRunning || isOverLimit;
  const hasNoSelectedTags = isEmptyArray(selectedTags);
  const sectionItems = [{ id: null, name: "Без раздела" }, ...sections].map((section) => ({
    key: section.id ?? "none",
    id: section.id,
    name: section.name,
  }));
  const tagsTitle = tagsMode === "removeTags" ? "Снять теги" : "Добавить теги";
  /** Применяет набор тегов и закрывает поле. */
  const handleTags = (mode: "addTags" | "removeTags", tags: string[]): void => {
    const label = mode === "addTags" ? "Добавить теги" : "Снять теги";
    onRun({ type: mode, tags }, `${label}: ${tags.join(", ")}`);
    setTagsMode(null);
  };
  const sectionMenuItems = sectionItems.map((section) => (
    <Menu.Item
      key={section.key}
      onClick={() =>
        onRun({ type: "move", sectionId: section.id }, `Переместить в «${section.name}»`)
      }
    >
      {section.name}
    </Menu.Item>
  ));
  const stateMenuItems = STATE_ACTIONS.map((action) => (
    <Menu.Item key={action.key} onClick={() => onRun(action.operation, action.label)}>
      {action.label}
    </Menu.Item>
  ));
  return (
    <div
      {...rootAttrs}
      className={clsx(styles.root, className)}
      role="region"
      aria-label="Действия с выбранными материалами"
    >
      <p className={styles.count} aria-live="polite">
        Выбрано: {count}
      </p>
      {!isWide && (
        <div className={styles.compact}>
          <Menu position="top-end" withinPortal>
            <Menu.Target>
              <Button
                size="xs"
                radius="xl"
                variant="default"
                disabled={isDisabled}
                leftSection={<MoreHorizontal size={14} aria-hidden="true" />}
              >
                Действия
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>В раздел</Menu.Label>
              {sectionMenuItems}
              <Menu.Divider />
              <Menu.Item onClick={() => setTagsMode("addTags")}>Добавить теги…</Menu.Item>
              <Menu.Item disabled={hasNoSelectedTags} onClick={() => setTagsMode("removeTags")}>
                Снять теги…
              </Menu.Item>
              <Menu.Divider />
              {stateMenuItems}
            </Menu.Dropdown>
          </Menu>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="lg"
            disabled={isRunning}
            aria-label="Снять выбор"
            onClick={onClear}
          >
            <X size={16} aria-hidden="true" />
          </ActionIcon>
        </div>
      )}
      {isWide && (
        <div className={styles.actions}>
          <Menu position="top-start" withinPortal>
            <Menu.Target>
              <Button
                size="xs"
                radius="xl"
                variant="default"
                disabled={isDisabled}
                leftSection={<FolderInput size={14} aria-hidden="true" />}
                rightSection={<ChevronDown size={13} aria-hidden="true" />}
              >
                В раздел
              </Button>
            </Menu.Target>
            <Menu.Dropdown>{sectionMenuItems}</Menu.Dropdown>
          </Menu>
          <Popover
            opened={tagsMode === "addTags"}
            position="top-start"
            width={320}
            trapFocus
            withinPortal
            onChange={(isOpened) => setTagsMode(isOpened ? "addTags" : null)}
          >
            <Popover.Target>
              <Button
                size="xs"
                radius="xl"
                variant="default"
                disabled={isDisabled}
                leftSection={<Tag size={14} aria-hidden="true" />}
                onClick={() => setTagsMode(tagsMode === "addTags" ? null : "addTags")}
              >
                Добавить теги
              </Button>
            </Popover.Target>
            <Popover.Dropdown>
              <BulkTagsForm
                mode="addTags"
                projectId={projectId}
                selectedTags={selectedTags}
                onApply={(tags) => handleTags("addTags", tags)}
              />
            </Popover.Dropdown>
          </Popover>
          <Popover
            opened={tagsMode === "removeTags"}
            position="top-start"
            width={320}
            trapFocus
            withinPortal
            onChange={(isOpened) => setTagsMode(isOpened ? "removeTags" : null)}
          >
            <Popover.Target>
              <Button
                size="xs"
                radius="xl"
                variant="default"
                disabled={isDisabled || hasNoSelectedTags}
                leftSection={<TagsIcon size={14} aria-hidden="true" />}
                onClick={() => setTagsMode(tagsMode === "removeTags" ? null : "removeTags")}
              >
                Снять теги
              </Button>
            </Popover.Target>
            <Popover.Dropdown>
              <BulkTagsForm
                mode="removeTags"
                projectId={projectId}
                selectedTags={selectedTags}
                onApply={(tags) => handleTags("removeTags", tags)}
              />
            </Popover.Dropdown>
          </Popover>
          <Menu position="top-start" withinPortal>
            <Menu.Target>
              <Button
                size="xs"
                radius="xl"
                variant="default"
                disabled={isDisabled}
                rightSection={<ChevronDown size={13} aria-hidden="true" />}
              >
                Состояние
              </Button>
            </Menu.Target>
            <Menu.Dropdown>{stateMenuItems}</Menu.Dropdown>
          </Menu>
          <Button
            size="xs"
            radius="xl"
            variant="subtle"
            color="gray"
            disabled={isRunning}
            leftSection={<X size={14} aria-hidden="true" />}
            onClick={onClear}
          >
            Снять выбор
          </Button>
        </div>
      )}
      {isOverLimit && (
        <p className={styles.limit}>За один раз можно изменить не более 100 материалов.</p>
      )}
      <Modal
        opened={!isWide && tagsMode !== null}
        title={tagsTitle}
        onClose={() => setTagsMode(null)}
      >
        {tagsMode !== null && (
          <BulkTagsForm
            mode={tagsMode}
            projectId={projectId}
            selectedTags={selectedTags}
            onApply={(tags) => handleTags(tagsMode, tags)}
          />
        )}
      </Modal>
    </div>
  );
};
