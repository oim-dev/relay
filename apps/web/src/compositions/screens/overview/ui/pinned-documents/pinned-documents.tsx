import clsx from "clsx";
import { Link } from "react-router-dom";
import { isDefined, isEmptyArray, isNonEmptyArray } from "shared/value-predicates";
import { countLabel } from "../../helpers/count-label";
import type { PinnedDocumentsProps } from "./types/pinned-documents-props.type";
import styles from "./styles/pinned-documents.module.css";

/**
 * Показывает состав библиотеки и закреплённые действующие документы.
 *
 * Используется для:
 *  - быстрого перехода к ключевым материалам проекта
 */
export const PinnedDocuments = (props: PinnedDocumentsProps) => {
  const { documents, basePath, className, ...rootAttrs } = props;
  const statsLabel = [
    countLabel("Закреплено", documents.pinned),
    countLabel("разделов", documents.sections.total),
    countLabel("без\u00A0раздела", documents.sections.unsectioned),
  ].join(", ");
  const documentItems = documents.pinnedActive.items.map((document) => ({
    ...document,
    path: `${basePath}/documents/${encodeURIComponent(document.id)}`,
    summaryText: document.summary === "" ? null : document.summary,
  }));
  const shouldShowEmptyState = isEmptyArray(documentItems);
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <p className={styles.stats}>{statsLabel}</p>
      {isNonEmptyArray(documentItems) && (
        <ul className={styles.list} aria-label="Закреплённые действующие документы">
          {documentItems.map((document) => (
            <li key={document.id}>
              <Link to={document.path} className={styles.link}>
                <span className={styles.name}>{document.name}</span>
                {isDefined(document.summaryText) && (
                  <span className={styles.summary}>{document.summaryText}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {shouldShowEmptyState && (
        <p className={styles.empty}>
          Нет закреплённых действующих документов.{" "}
          <Link to={`${basePath}/documents?view=pinned`}>Закреплённые в библиотеке</Link>
        </p>
      )}
    </div>
  );
};
