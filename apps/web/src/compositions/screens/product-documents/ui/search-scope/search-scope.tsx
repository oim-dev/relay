import clsx from "clsx";
import { Button } from "@mantine/core";
import { Globe, X } from "lucide-react";
import type { SearchScopeProps } from "./types/search-scope-props.type";
import styles from "./styles/search-scope.module.css";

/**
 * Объясняет, где выполняется поиск, и предлагает расширить его, сохранив строку.
 *
 * Используется для:
 *  - понимания пустой или неполной выдачи в разделе, представлении или под фильтром
 */
export const SearchScope = (props: SearchScopeProps) => {
  const { query, scopeParts, isNarrow, onSearchEverywhere, onReset, className, ...rootAttrs } =
    props;
  const hasQuery = query !== "";
  const scopeLabel = scopeParts.join(" · ");
  const lead = hasQuery ? "Ищем" : "Показаны материалы";
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <p className={styles.text}>
        {lead}
        {hasQuery && (
          <>
            {" "}
            <strong className={styles.query}>«{query}»</strong>
          </>
        )}{" "}
        в области: <span className={styles.scope}>{scopeLabel}</span>
      </p>
      <div className={styles.actions}>
        {isNarrow && hasQuery && (
          <Button
            size="xs"
            radius="xl"
            variant="light"
            leftSection={<Globe size={13} aria-hidden="true" />}
            onClick={onSearchEverywhere}
          >
            Искать во всей библиотеке
          </Button>
        )}
        <Button
          size="xs"
          radius="xl"
          variant="subtle"
          color="gray"
          leftSection={<X size={13} aria-hidden="true" />}
          onClick={onReset}
        >
          Сбросить
        </Button>
      </div>
    </div>
  );
};
