import { useId } from "react";
import clsx from "clsx";
import { Button, Checkbox, Select, VisuallyHidden } from "@mantine/core";
import { ChevronDown } from "lucide-react";
import { isDefined, isNonEmptyArray } from "shared/value-predicates";
import { SORT_OPTIONS } from "./config/sort.config";
import { MaterialRow } from "./ui/material-row/material-row";
import type { MaterialListProps } from "./types/material-list-props.type";
import styles from "./styles/material-list.module.css";

/**
 * Показывает выдачу каталога компактными строками с продолжением порциями.
 *
 * Используется для:
 *  - чтения выбранной области библиотеки и результатов поиска
 *  - перехода к материалу, предпросмотра и быстрых изменений свойств
 */
export const MaterialList = (props: MaterialListProps) => {
  const {
    title,
    total,
    items,
    sections,
    query,
    sort,
    isSortFixed,
    getHref,
    returnTo,
    busyIds,
    selectedIds,
    hasMore,
    isLoadingMore,
    state,
    onSortChange,
    onLoadMore,
    onOpen,
    onPreview,
    onChange,
    onSelect,
    className,
    ...rootAttrs
  } = props;
  const titleId = useId();
  const sectionNames = new Map(sections.map((section) => [section.id, section.name]));
  const rowItems = items.map((material) => ({
    material,
    sectionName: sectionNames.get(material.document.sectionId ?? "") ?? "Без раздела",
    isBusy: busyIds.has(material.ref.id),
    isSelected: selectedIds.has(material.ref.id),
  }));
  const selectedShown = rowItems.filter((row) => row.isSelected).length;
  const isAllSelected = selectedShown > 0 && selectedShown === rowItems.length;
  const isPartlySelected = selectedShown > 0 && !isAllSelected;
  const totalLabel = isDefined(total) ? String(total) : "—";
  const shownLabel = isDefined(total) ? `Показано ${items.length} из ${total}` : "";
  const hasItems = isNonEmptyArray(items);
  return (
    <section {...rootAttrs} className={clsx(styles.root, className)} aria-labelledby={titleId}>
      <header className={styles.header}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <span className={styles.total}>
          <VisuallyHidden>Материалов: </VisuallyHidden>
          {totalLabel}
        </span>
        <Select
          className={styles.sort}
          aria-label="Порядок материалов"
          size="xs"
          allowDeselect={false}
          disabled={isSortFixed}
          value={sort}
          data={SORT_OPTIONS}
          onChange={(value) => onSortChange(value === "title" ? "title" : "updated")}
        />
      </header>
      {state}
      {hasItems && (
        <Checkbox
          className={styles.selectAll}
          size="sm"
          label={`Выбрать все показанные (${items.length})`}
          checked={isAllSelected}
          indeterminate={isPartlySelected}
          onChange={(event) => onSelect(items, event.currentTarget.checked)}
        />
      )}
      {hasItems && (
        <ul className={styles.list} aria-label={title}>
          {rowItems.map((row) => (
            <li
              key={row.material.ref.id}
              className={styles.item}
              data-material-id={row.material.ref.id}
            >
              <MaterialRow
                material={row.material}
                sectionName={row.sectionName}
                href={getHref(row.material.ref.id)}
                returnTo={returnTo}
                query={query}
                sections={sections}
                isBusy={row.isBusy}
                isSelected={row.isSelected}
                onSelectChange={(isSelected) => onSelect([row.material], isSelected)}
                onOpen={() => onOpen(row.material.ref.id)}
                onPreview={() => onPreview(row.material)}
                onChange={(changes) => onChange(row.material, changes)}
              />
            </li>
          ))}
        </ul>
      )}
      {hasItems && (
        <footer className={styles.footer}>
          <p className={styles.shown} role="status">
            {shownLabel}
          </p>
          {hasMore && (
            <Button
              variant="default"
              radius="xl"
              loading={isLoadingMore}
              rightSection={<ChevronDown size={15} aria-hidden="true" />}
              onClick={onLoadMore}
            >
              Показать ещё
            </Button>
          )}
        </footer>
      )}
    </section>
  );
};
