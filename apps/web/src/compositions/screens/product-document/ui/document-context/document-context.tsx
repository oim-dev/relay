import { Anchor } from "@mantine/core";
import { Link } from "react-router-dom";
import { Folder } from "lucide-react";
import { useProjectBasePath } from "domains/project";
import { DOCUMENT_KINDS, DOCUMENT_STATUSES, MATERIAL_FORMATS } from "domains/documents";
import { isEmptyArray } from "shared/value-predicates";
import type { DocumentContextProps } from "./types/document-context-props.type";
import styles from "./styles/document-context.module.css";

/**
 * Даёт свойства материала рядом с содержанием, не превращая чтение в форму.
 *
 * Используется для:
 *  - понимания формата, типа, состояния, раздела и тегов материала
 *  - перехода к разделу библиотеки и к разделам длинного текста
 */
export const DocumentContext = ({ document, sectionName, outline }: DocumentContextProps) => {
  const base = useProjectBasePath();
  const hasOutline = outline.length >= 3;
  const hasTags = !isEmptyArray(document.tags);
  const sectionHref = document.sectionId
    ? `${base}/documents?section=${encodeURIComponent(document.sectionId)}`
    : `${base}/documents?view=none`;
  const updatedLabel = document.updatedAt
    ? new Date(document.updatedAt).toLocaleDateString("ru-RU", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "—";
  return (
    <aside className={styles.root} aria-label="Свойства материала">
      <h2 className={styles.title}>О материале</h2>
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>Формат</dt>
          <dd>{MATERIAL_FORMATS[document.documentFormat]}</dd>
        </div>
        <div className={styles.fact}>
          <dt>Тип</dt>
          <dd>{DOCUMENT_KINDS[document.documentKind]}</dd>
        </div>
        <div className={styles.fact}>
          <dt>Состояние</dt>
          <dd>{DOCUMENT_STATUSES[document.documentStatus]}</dd>
        </div>
        <div className={styles.fact}>
          <dt>Раздел</dt>
          <dd>
            <Anchor component={Link} to={sectionHref} className={styles.sectionLink}>
              <Folder size={14} aria-hidden="true" />
              {sectionName}
            </Anchor>
          </dd>
        </div>
        <div className={styles.fact}>
          <dt>Обновлён</dt>
          <dd>{updatedLabel}</dd>
        </div>
        <div className={styles.fact}>
          <dt>Ключ</dt>
          <dd className={styles.key}>{document.key}</dd>
        </div>
      </dl>
      <div>
        <h3 className={styles.subtitle}>Теги</h3>
        {hasTags && (
          <ul className={styles.tags}>
            {document.tags.map((tag) => (
              <li key={tag} className={styles.tag}>
                {tag}
              </li>
            ))}
          </ul>
        )}
        {!hasTags && <p className={styles.muted}>Тегов нет</p>}
      </div>
      {hasOutline && (
        <nav className={styles.outline} aria-label="Содержание материала">
          <h3 className={styles.subtitle}>Содержание</h3>
          {outline.map((entry) => (
            <Anchor
              key={entry.id}
              href={`#${entry.id}`}
              data-nested={entry.level > 2}
              className={styles.outlineLink}
              c="dimmed"
            >
              {entry.title}
            </Anchor>
          ))}
        </nav>
      )}
    </aside>
  );
};
