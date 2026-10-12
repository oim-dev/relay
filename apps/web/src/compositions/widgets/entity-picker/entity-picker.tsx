import { useState } from "react";
import {
  Button,
  CloseButton,
  Combobox,
  Group,
  InputBase,
  ScrollArea,
  Stack,
  Text,
  useCombobox,
} from "@mantine/core";
import type { ComboboxItem } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { relationAddress } from "domains/relations";
import { useEntities, useEntitySummary, entityKindLabel } from "domains/entities";
import { isEmptyArray } from "shared/value-predicates";
import type { EntityPickerProps } from "./types/entity-picker-props.type";

/** Ширина списка вариантов: длинные названия и переход по страницам без обрезки. */
const OPTIONS_WIDTH = "min(22rem, calc(100vw - 2rem))";

/**
 * Выбирает сущность проекта по названию, ключу или адресу.
 *
 * Используется для:
 *  - ввода начала и конца связи и фильтрации библиотеки по сущности
 */
export const EntityPicker = (props: EntityPickerProps) => {
  const { projectId, value, defaultValue, onChange, ...fieldProps } = props;
  const [localValue, setLocalValue] = useState<string | null>(defaultValue ?? null);
  const [selectedOption, setSelectedOption] = useState<ComboboxItem | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState({ offset: 0, version: undefined as string | undefined });
  const combobox = useCombobox({ onDropdownClose: () => setSearch("") });
  const selected = value === undefined ? localValue : value;
  const selection = useEntitySummary(projectId, selected === "" ? null : selected);
  const selectedNode = selection.data;
  const selectedAddress = selectedNode ? relationAddress(selectedNode.ref) : selected;
  const selectedLabel = selectedNode
    ? `${selectedNode.key} · ${selectedNode.title} (${entityKindLabel(selectedNode.ref.kind)})`
    : selectedOption?.value === selected
      ? selectedOption.label
      : selected;
  const [debouncedSearch] = useDebouncedValue(search === selectedLabel ? "" : search, 200);
  const response = useEntities(projectId, { q: debouncedSearch, limit: 40, ...page });
  const optionsData = (response.data?.items ?? []).map((node) => ({
    value: relationAddress(node.ref),
    label: `${node.key} · ${node.title} (${entityKindLabel(node.ref.kind)})`,
  }));
  if (selectedAddress && !optionsData.some((option) => option.value === selectedAddress))
    optionsData.unshift({
      value: selectedAddress,
      label: selectedLabel ?? selectedAddress,
    });
  const nextOffset = response.data?.nextOffset;
  const hasMore =
    nextOffset !== undefined &&
    nextOffset !== null &&
    (response.data?.total ?? 0) > page.offset + 40;
  const errorMessage = response.error?.message ?? selection.error?.message;
  const hasError = errorMessage !== undefined;
  const emptyMessage = response.isLoading ? "Загружаем сущности…" : "Сущностей не найдено";
  const inputValue = combobox.dropdownOpened ? search : (selectedLabel ?? "");
  const hasSelection = selected !== null && selected !== "";
  const hasPrevious = page.offset > 0;
  const hasPages = hasMore || hasPrevious;
  const hasNoOptions = isEmptyArray(optionsData);
  const pageLabel = `${page.offset + 1}–${Math.min(page.offset + 40, response.data?.total ?? 0)} из ${response.data?.total ?? 0}`;
  /** Сбрасывает продолжение при изменении серверного поиска. */
  const handleSearch = (text: string): void => {
    setSearch(text);
    setPage({ offset: 0, version: undefined });
  };
  /** Начинает новую страницу после ошибки сети или изменения снимка, сохраняя выбор. */
  const handleRefresh = (): void => {
    setPage({ offset: 0, version: undefined });
    void response.mutate().catch(() => undefined);
    void selection.mutate().catch(() => undefined);
  };
  return (
    <Stack gap={4}>
      <Combobox
        store={combobox}
        width={OPTIONS_WIDTH}
        position="bottom-start"
        onOptionSubmit={(address) => {
          const option = optionsData.find((entry) => entry.value === address);
          if (option === undefined) return;
          setLocalValue(address);
          setSelectedOption(option);
          onChange?.(address, option);
          combobox.closeDropdown();
        }}
      >
        <Combobox.Target>
          <InputBase
            {...fieldProps}
            value={inputValue}
            autoComplete="off"
            onChange={(event) => {
              handleSearch(event.currentTarget.value);
              combobox.openDropdown();
              combobox.resetSelectedOption();
            }}
            onFocus={() => combobox.openDropdown()}
            onClick={() => combobox.openDropdown()}
            onBlur={(event) => {
              if (
                !(event.relatedTarget instanceof HTMLElement) ||
                !event.relatedTarget.closest("[data-entity-picker-options]")
              )
                combobox.closeDropdown();
              fieldProps.onBlur?.(event);
            }}
            rightSectionPointerEvents="all"
            rightSection={
              hasSelection && (
                <CloseButton
                  size="sm"
                  aria-label="Очистить выбранную сущность"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setLocalValue(null);
                    setSelectedOption(null);
                    onChange?.(null, { value: "", label: "" });
                  }}
                />
              )
            }
          />
        </Combobox.Target>
        <Combobox.Dropdown
          data-entity-picker-options
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) combobox.closeDropdown();
          }}
        >
          <ScrollArea.Autosize mah={240} type="auto" scrollbars="y">
            <Combobox.Options>
              {optionsData.map((option) => (
                <Combobox.Option key={option.value} value={option.value}>
                  <Text size="sm" style={{ overflowWrap: "anywhere" }}>
                    {option.label}
                  </Text>
                </Combobox.Option>
              ))}
              {hasNoOptions && <Combobox.Empty>{emptyMessage}</Combobox.Empty>}
            </Combobox.Options>
          </ScrollArea.Autosize>
          {hasPages && (
            <Group
              justify="space-between"
              gap="xs"
              p="xs"
              wrap="nowrap"
              onMouseDown={(event) => event.preventDefault()}
            >
              <Button
                size="xs"
                variant="subtle"
                disabled={!hasPrevious}
                onClick={() =>
                  setPage({
                    offset: Math.max(0, page.offset - 40),
                    version: response.data?.version,
                  })
                }
              >
                Назад
              </Button>
              <Text size="xs" c="dimmed" ta="center">
                {pageLabel}
              </Text>
              <Button
                size="xs"
                variant="subtle"
                disabled={!hasMore}
                onClick={() =>
                  setPage({ offset: nextOffset ?? 0, version: response.data?.version })
                }
              >
                Ещё варианты
              </Button>
            </Group>
          )}
        </Combobox.Dropdown>
      </Combobox>
      {hasError && (
        <Group gap="xs" align="center" role="alert">
          <Text size="xs" c="danger">
            {errorMessage}
          </Text>
          <Button size="xs" variant="subtle" onClick={handleRefresh}>
            Обновить варианты
          </Button>
        </Group>
      )}
    </Stack>
  );
};
