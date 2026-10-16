import { ActionIcon, NavLink, Select } from "@mantine/core";
import { Box, FileText, ListChecks, Settings } from "lucide-react";
import type { KitNavSampleProps } from "./types/kit-nav-sample-props.type";

const PROJECTS = [
  { value: "relay", label: "Relay" },
  { value: "archive", label: "Архив поддержки", disabled: true },
];

/**
 * Рисует один навигационный контрол каркаса в зафиксированном состоянии: наведение
 * и фокус задаются атрибутом темы data-tasks-preview, остальное — теми же свойствами
 * и модификаторами, что в каркасе; оформление — общие правила темы.
 *
 * Используется для:
 *  - таблицы состояний навигации галереи
 */
export const KitNavSample = (props: KitNavSampleProps) => {
  const { control, state } = props;
  const isCurrent = state === "current";
  const isDisabled = state === "disabled";
  const isFocused = state === "focus";
  // Наведение и фокус нельзя задать инертному образцу событием: тема рисует их по атрибуту.
  const previewState = state === "hover" || isFocused ? state : undefined;
  const ariaCurrent = isCurrent ? "page" : undefined;

  if (control === "select") {
    const selectState = state === "hover" || state === "expanded" || isFocused ? state : undefined;
    return (
      <Select
        aria-label="Выбрать проект"
        data={PROJECTS}
        defaultValue="relay"
        allowDeselect={false}
        disabled={isDisabled}
        variant="navigation"
        data-tasks-preview={selectState}
      />
    );
  }

  if (control === "icon") {
    const variant = isCurrent ? "light" : "subtle";
    const isExpanded = state === "expanded" ? true : undefined;
    return (
      <ActionIcon
        aria-label="Настройки проекта"
        variant={variant}
        aria-current={ariaCurrent}
        aria-expanded={isExpanded}
        aria-haspopup="menu"
        disabled={isDisabled}
        data-tasks-preview={previewState}
      >
        <Settings size={18} aria-hidden="true" />
      </ActionIcon>
    );
  }

  if (control === "group") {
    const isCurrentGroup = state === "current-group";
    const childCurrent = isCurrentGroup ? "page" : undefined;
    return (
      <NavLink
        component="button"
        type="button"
        label="Продукт"
        leftSection={<Box size={17} aria-hidden="true" />}
        mod={{ "current-group": isCurrentGroup }}
        opened
        childrenOffset={0}
        aria-expanded
      >
        <div>
          <NavLink
            component="a"
            href="#kit-shell"
            label="Паспорт"
            leftSection={<FileText size={15} aria-hidden="true" />}
            aria-current={childCurrent}
            mod={{ nested: true }}
          />
        </div>
      </NavLink>
    );
  }

  const isChild = control === "child";
  const Icon = isChild ? FileText : ListChecks;
  const label = isChild ? "Паспорт" : "Релизы";
  const iconSize = isChild ? 15 : 17;
  return (
    <NavLink
      component="a"
      href="#kit-shell"
      label={label}
      leftSection={<Icon size={iconSize} aria-hidden="true" />}
      aria-current={ariaCurrent}
      disabled={isDisabled}
      data-tasks-preview={previewState}
      mod={{ nested: isChild }}
    />
  );
};
