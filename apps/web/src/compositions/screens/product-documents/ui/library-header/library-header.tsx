import { useEffect, useRef } from "react";
import { Button, CloseButton, TextInput } from "@mantine/core";
import { PanelLeft, Plus, Search, SlidersHorizontal } from "lucide-react";
import { Link } from "react-router-dom";
import type { LibraryHeaderProps } from "./types/library-header-props.type";
import styles from "./styles/library-header.module.css";

/**
 * Открывает каталог названием, поиском и добавлением материала.
 * При входе на экран переводит свободный фокус на заголовок, чтобы переход был объявлен.
 *
 * Используется для:
 *  - поиска по библиотеке и создания материала
 *  - доступа к разделам и фильтрам на узком экране
 */
export const LibraryHeader = (props: LibraryHeaderProps) => {
  const { query, createHref, returnTo, filterCount } = props;
  const { onQueryChange, onOpenNavigation, onOpenFilters } = props;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const hasQuery = query !== "";
  const clearButton = hasQuery && (
    <CloseButton size="sm" aria-label="Очистить поиск" onClick={() => onQueryChange("")} />
  );
  const filtersLabel = filterCount > 0 ? `Фильтры: ${filterCount}` : "Фильтры";
  useEffect(() => {
    document.title = "Библиотека знаний · Relay";
    /* Не перехватывает фокус, уже возвращённый к материалу после возврата в каталог. */
    if (document.activeElement === document.body || document.activeElement === null)
      headingRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <header className={styles.root}>
      <div className={styles.identity}>
        <h1 ref={headingRef} tabIndex={-1} className={styles.title}>
          Библиотека знаний
        </h1>
        <p className={styles.description}>
          Материалы проекта: контекст, решения, правила и инструкции для людей и агентов.
        </p>
      </div>
      <div className={styles.tools}>
        <TextInput
          className={styles.search}
          type="search"
          size="md"
          radius="xl"
          aria-label="Поиск материалов"
          placeholder="Найти материал…"
          leftSection={<Search size={17} aria-hidden="true" />}
          rightSection={clearButton}
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
        />
        <Button
          component={Link}
          to={createHref}
          state={{ returnTo }}
          size="md"
          radius="xl"
          className={styles.create}
          leftSection={<Plus size={17} aria-hidden="true" />}
        >
          Добавить материал
        </Button>
      </div>
      <div className={styles.mobileTools}>
        <Button
          variant="default"
          radius="xl"
          className={styles.navigationButton}
          leftSection={<PanelLeft size={15} aria-hidden="true" />}
          onClick={onOpenNavigation}
        >
          Разделы
        </Button>
        <Button
          variant="default"
          radius="xl"
          className={styles.filtersButton}
          leftSection={<SlidersHorizontal size={15} aria-hidden="true" />}
          onClick={onOpenFilters}
        >
          {filtersLabel}
        </Button>
      </div>
    </header>
  );
};
