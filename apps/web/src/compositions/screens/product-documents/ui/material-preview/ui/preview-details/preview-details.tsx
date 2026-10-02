import { useId } from "react";
import { Anchor } from "@mantine/core";
import { ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import {
  DOCUMENT_KINDS,
  DOCUMENT_RELATION_TYPES,
  DOCUMENT_STATUSES,
  useEntityHref,
} from "domains/documents";
import { entityKindLabel } from "domains/entities";
import { useProjectBasePath, useProjectId } from "domains/project";
import { MarkdownView } from "ui/markdown-view";
import { isDefined, isEmptyArray, isNonEmptyArray } from "shared/value-predicates";
import type { PreviewDetailsProps } from "./types/preview-details-props.type";
import styles from "./styles/preview-details.module.css";

/**
 * Раскрывает назначение, свойства, использование и текст прочитанного материала.
 *
 * Используется для:
 *  - содержимого панели быстрого предпросмотра каталога
 */
export const PreviewDetails = (props: PreviewDetailsProps) => {
  const { document, sectionName } = props;
  const base = useProjectBasePath();
  const projectId = useProjectId();
  const getEntityHref = useEntityHref(projectId, base);
  const isLink = document.documentFormat === "link";
  const relationTypes = new Map(
    [...document.legacyLinks, ...document.relations].map((relation) => [
      `${relation.target.kind}:${relation.target.id}`,
      DOCUMENT_RELATION_TYPES[relation.type],
    ]),
  );
  const usageItems = document.references.map((reference) => ({
    id: `${reference.ref.kind}:${reference.ref.id}`,
    title: reference.title,
    meta: [
      entityKindLabel(reference.ref.kind),
      relationTypes.get(`${reference.ref.kind}:${reference.ref.id}`),
    ]
      .filter(isDefined)
      .join(" · "),
    href: getEntityHref(reference),
  }));
  const formatLabel = isLink ? "Внешняя ссылка" : "Markdown-текст";
  const updatedLabel = new Date(document.updatedAt).toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const pinnedLabel = document.pinned ? "Да" : "Нет";
  const hasSummary = document.summary.trim() !== "";
  const hasNoUsage = isEmptyArray(usageItems);
  const urlValue = isDefined(document.url) && (
    <Anchor href={document.url} target="_blank" rel="noreferrer noopener" className={styles.url}>
      {document.url}
      <ExternalLink size={13} aria-label="откроется в новой вкладке" />
    </Anchor>
  );
  const propertyItems = [
    { term: "Тип", value: DOCUMENT_KINDS[document.documentKind] },
    { term: "Состояние", value: DOCUMENT_STATUSES[document.documentStatus] },
    { term: "Раздел", value: sectionName },
    { term: "Формат", value: formatLabel },
    ...(isDefined(document.url) ? [{ term: "Адрес", value: urlValue }] : []),
    ...(isNonEmptyArray(document.tags) ? [{ term: "Теги", value: document.tags.join(", ") }] : []),
    { term: "Закреплён", value: pinnedLabel },
    { term: "Обновлён", value: updatedLabel },
    { term: "Ключ", value: document.key },
  ];
  const propertiesId = useId();
  const usageId = useId();
  const contentId = useId();
  const contentEmptyText = isLink ? "Пояснение к ссылке не заполнено." : "Текст не заполнен.";
  return (
    <div className={styles.root}>
      {hasSummary && <p className={styles.summary}>{document.summary}</p>}
      <section className={styles.block} aria-labelledby={propertiesId}>
        <h3 id={propertiesId} className={styles.heading}>
          Свойства
        </h3>
        <dl className={styles.properties}>
          {propertyItems.map((item) => (
            <div key={item.term} className={styles.property}>
              <dt className={styles.term}>{item.term}</dt>
              <dd className={styles.value}>{item.value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className={styles.block} aria-labelledby={usageId}>
        <h3 id={usageId} className={styles.heading}>
          Использование
        </h3>
        {hasNoUsage && (
          <p className={styles.empty}>Материал пока не прикреплён ни к одной записи проекта.</p>
        )}
        {isNonEmptyArray(usageItems) && (
          <ul className={styles.usage}>
            {usageItems.map((item) => (
              <li key={item.id} className={styles.usageItem}>
                <Anchor component={Link} to={item.href} className={styles.usageTitle}>
                  {item.title}
                </Anchor>
                <span className={styles.usageMeta}>{item.meta}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className={styles.block} aria-labelledby={contentId}>
        <h3 id={contentId} className={styles.heading}>
          Содержание
        </h3>
        <MarkdownView
          className={styles.content}
          text={document.body}
          emptyText={contentEmptyText}
        />
      </section>
    </div>
  );
};
