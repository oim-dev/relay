import { ActionIcon, Loader, Menu } from "@mantine/core";
import {
  Archive,
  ArchiveRestore,
  Check,
  FolderInput,
  MoreHorizontal,
  Pin,
  PinOff,
} from "lucide-react";
import type { MaterialActionsProps } from "./types/material-actions-props.type";

/**
 * Собирает редкие изменения материала в одно меню, не перегружая строку каталога.
 *
 * Используется для:
 *  - закрепления, перемещения в раздел и архивирования без открытия редактора
 */
export const MaterialActions = (props: MaterialActionsProps) => {
  const { title, isPinned, isArchived, sectionId, sections, isBusy, onChange } = props;
  const pinLabel = isPinned ? "Открепить" : "Закрепить";
  const PinIcon = isPinned ? PinOff : Pin;
  const archiveLabel = isArchived ? "Вернуть из архива" : "В архив";
  const ArchiveIcon = isArchived ? ArchiveRestore : Archive;
  /* Кнопка остаётся доступной во время записи, чтобы меню вернуло на неё фокус. */
  const TargetIcon = isBusy ? Loader : MoreHorizontal;
  const archiveStatus = isArchived ? "active" : "archived";
  const sectionItems = [{ id: null, name: "Без раздела" }, ...sections].map((section) => ({
    key: section.id ?? "none",
    id: section.id,
    name: section.name,
    isCurrent: section.id === sectionId,
    indicator: section.id === sectionId ? <Check size={14} aria-label="Текущий раздел" /> : null,
  }));
  return (
    <Menu position="bottom-end" withinPortal shadow="md">
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="lg"
          aria-busy={isBusy}
          aria-label={`Действия: ${title}`}
        >
          <TargetIcon size={18} color="currentColor" aria-hidden="true" />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item
          disabled={isBusy}
          leftSection={<PinIcon size={15} aria-hidden="true" />}
          onClick={() => onChange({ pinned: !isPinned })}
        >
          {pinLabel}
        </Menu.Item>
        <Menu.Sub position="left-start">
          <Menu.Sub.Target>
            <Menu.Sub.Item leftSection={<FolderInput size={15} aria-hidden="true" />}>
              Переместить в раздел
            </Menu.Sub.Item>
          </Menu.Sub.Target>
          <Menu.Sub.Dropdown aria-label="Разделы">
            {sectionItems.map((section) => (
              <Menu.Item
                key={section.key}
                disabled={section.isCurrent || isBusy}
                rightSection={section.indicator}
                onClick={() => onChange({ sectionId: section.id })}
              >
                {section.name}
              </Menu.Item>
            ))}
          </Menu.Sub.Dropdown>
        </Menu.Sub>
        <Menu.Divider />
        <Menu.Item
          disabled={isBusy}
          leftSection={<ArchiveIcon size={15} aria-hidden="true" />}
          onClick={() => onChange({ documentStatus: archiveStatus })}
        >
          {archiveLabel}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
};
