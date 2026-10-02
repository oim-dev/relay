import clsx from "clsx";
import { Anchor, Button } from "@mantine/core";
import { ArrowUpRight, Pencil, Unlink } from "lucide-react";
import { Link } from "react-router-dom";
import { DOCUMENT_RELATION_TYPES } from "domains/documents";
import { MarkdownView } from "ui/markdown-view";
import type { RelationItemProps } from "./types/relation-item-props.type";
import styles from "./styles/relation-item.module.css";

/**
 * Показывает одну прямую связь материала: сущность, смысл связи и пояснение,
 * а также действия изменения и снятия.
 *
 * Используется для:
 *  - перехода к сущности, где используется материал
 *  - изменения или снятия отдельной связи без открытия редактора
 */
export const RelationItem = (props: RelationItemProps) => {
  const { entry, returnTo, onEdit, onDetach, className, ...rootAttrs } = props;
  const { relation, isLegacy, title, entityKey, href } = entry;
  const typeLabel = DOCUMENT_RELATION_TYPES[relation.type];
  const hasDescription = relation.description.trim() !== "";
  return (
    <li {...rootAttrs} className={clsx(styles.root, className)}>
      <div className={styles.main}>
        {href === null && <span className={styles.title}>{title}</span>}
        {href !== null && (
          <Anchor component={Link} to={href} state={{ returnTo }} className={styles.title}>
            {title}
            <ArrowUpRight size={14} aria-hidden="true" className={styles.arrow} />
          </Anchor>
        )}
        <div className={styles.facts}>
          <span className={styles.key}>{entityKey}</span>
          <span className={styles.type} data-type={relation.type}>
            {typeLabel}
          </span>
          {isLegacy && (
            <span className={styles.legacy} title="Прежняя форма прикрепления области">
              Прежняя область
            </span>
          )}
        </div>
        {hasDescription && (
          <div className={styles.description}>
            <MarkdownView text={relation.description} compact />
          </div>
        )}
      </div>
      <div className={styles.actions}>
        <Button
          size="compact-sm"
          variant="subtle"
          color="gray"
          leftSection={<Pencil size={13} aria-hidden="true" />}
          aria-label={`Изменить связь с «${title}»`}
          onClick={onEdit}
        >
          Изменить
        </Button>
        <Button
          size="compact-sm"
          variant="subtle"
          color="gray"
          leftSection={<Unlink size={13} aria-hidden="true" />}
          aria-label={`Открепить от «${title}»`}
          onClick={onDetach}
        >
          Открепить
        </Button>
      </div>
    </li>
  );
};
