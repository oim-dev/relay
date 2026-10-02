import { Button, Skeleton } from "@mantine/core";
import { Globe, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { StatePanel } from "ui/state-panel";
import type { CatalogStateProps } from "./types/catalog-state-props.type";
import styles from "./styles/catalog-state.module.css";

/**
 * Объясняет, почему вместо выдачи нет материалов, и предлагает следующий шаг.
 * Пустая выдача под условиями не выдаётся за пустую библиотеку.
 *
 * Используется для:
 *  - первого чтения каталога
 *  - пустой библиотеки и пустой выдачи поиска или фильтра
 */
export const CatalogState = (props: CatalogStateProps) => {
  const { kind, createHref, returnTo, canSearchEverywhere, onSearchEverywhere, onReset } = props;
  if (kind === "loading") {
    return (
      <div className={styles.loading} role="status" aria-label="Загружаем материалы">
        <Skeleton height={64} radius="lg" />
        <Skeleton height={64} radius="lg" />
        <Skeleton height={64} radius="lg" />
      </div>
    );
  }
  if (kind === "empty-library") {
    return (
      <StatePanel
        title="В библиотеке пока нет материалов"
        description="Сохраните контекст, решение, правило или инструкцию — материал станет общей памятью проекта для людей и агентов."
        action={
          <Button
            component={Link}
            to={createHref}
            state={{ returnTo }}
            radius="xl"
            leftSection={<Plus size={15} aria-hidden="true" />}
          >
            Добавить материал
          </Button>
        }
      />
    );
  }
  return (
    <StatePanel
      title="Ничего не нашлось"
      description="В выбранной области нет подходящих материалов. Расширьте поиск или сбросьте условия — сама библиотека не пуста."
      action={
        <div className={styles.actions}>
          {canSearchEverywhere && (
            <Button
              radius="xl"
              variant="light"
              leftSection={<Globe size={15} aria-hidden="true" />}
              onClick={onSearchEverywhere}
            >
              Искать во всей библиотеке
            </Button>
          )}
          <Button radius="xl" variant="default" onClick={onReset}>
            Сбросить условия
          </Button>
        </div>
      }
    />
  );
};
