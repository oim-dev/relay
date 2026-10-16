import clsx from "clsx";
import { NativeSelect, TextInput } from "@mantine/core";
import { Search } from "lucide-react";
import type { PickerFiltersProps } from "./types/picker-filters-props.type";
import styles from "./styles/picker-filters.module.css";

/**
 * Задаёт поиск и фильтры раздела, типа и формата выборщика; счётчики приходят от сервера
 * по всей библиотеке.
 *
 * Используется для:
 *  - сужения библиотеки перед выбором материалов
 */
export const PickerFilters = (props: PickerFiltersProps) => {
  const {
    query,
    section,
    kind,
    format,
    sectionOptions,
    kindOptions,
    formatOptions,
    onChange,
    className,
    ...rootAttrs
  } = props;
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <TextInput
        className={styles.search}
        label="Поиск"
        placeholder="Название, текст, адрес или тег"
        leftSection={<Search size={15} aria-hidden="true" />}
        data-autofocus
        value={query}
        onChange={(event) => onChange("query", event.currentTarget.value)}
      />
      <NativeSelect
        className={styles.section}
        label="Раздел"
        data={sectionOptions}
        value={section}
        onChange={(event) => onChange("section", event.currentTarget.value)}
      />
      <NativeSelect
        label="Тип"
        data={kindOptions}
        value={kind}
        onChange={(event) => onChange("kind", event.currentTarget.value)}
      />
      <NativeSelect
        label="Формат"
        data={formatOptions}
        value={format}
        onChange={(event) => onChange("format", event.currentTarget.value)}
      />
    </div>
  );
};
