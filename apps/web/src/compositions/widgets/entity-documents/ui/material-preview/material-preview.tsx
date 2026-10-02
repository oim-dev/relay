import clsx from "clsx";
import { Alert, Anchor, Button, Skeleton } from "@mantine/core";
import { Link } from "react-router-dom";
import { ArrowUpRight, ExternalLink } from "lucide-react";
import {
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  MATERIAL_FORMATS,
  useDocument,
} from "domains/documents";
import { useProjectBasePath, useProjectId } from "domains/project";
import { MarkdownView } from "ui/markdown-view";
import { isDefined, isNonEmptyArray } from "shared/value-predicates";
import type { MaterialPreviewProps } from "./types/material-preview-props.type";
import styles from "./styles/material-preview.module.css";

/**
 * Показывает свойства и содержание материала, не покидая место работы с сущностью.
 *
 * Используется для:
 *  - панели предпросмотра блока «Материалы»
 *  - проверки материала перед прикреплением в выборщике библиотеки
 */
export const MaterialPreview = (props: MaterialPreviewProps) => {
  const { materialId, returnTo, className, ...rootAttrs } = props;
  const projectId = useProjectId();
  const base = useProjectBasePath();
  const query = useDocument(projectId, materialId);
  const documentData = query.data?.id === materialId ? query.data : undefined;
  const isLoading = !isDefined(documentData) && !isDefined(query.error);
  const hasError = !isDefined(documentData) && isDefined(query.error);
  const href = `${base}/documents/${materialId}`;
  const isLink = documentData?.documentFormat === "link";
  const hasSummary = isDefined(documentData) && documentData.summary.trim() !== "";
  const tagList = documentData?.tags ?? [];
  const metaItems = isDefined(documentData)
    ? [
        DOCUMENT_KINDS[documentData.documentKind],
        MATERIAL_FORMATS[documentData.documentFormat],
        DOCUMENT_STATUSES[documentData.documentStatus],
        documentData.key,
      ]
    : [];
  const isArchived = documentData?.documentStatus === "archived";
  const emptyText = isLink ? "Пояснение к ссылке не заполнено." : "Текст не заполнен.";
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <Button
        component={Link}
        to={href}
        state={{ returnTo }}
        size="xs"
        radius="xl"
        className={styles.open}
        rightSection={<ArrowUpRight size={14} aria-hidden="true" />}
      >
        Открыть полностью
      </Button>
      {isLoading && (
        <div className={styles.loading} aria-label="Читаем материал">
          <Skeleton height={16} />
          <Skeleton height={72} />
          <Skeleton height={160} />
        </div>
      )}
      {hasError && (
        <Alert color="orange" title="Не удалось прочитать материал">
          {query.error?.message}
          <Button size="xs" variant="subtle" onClick={() => void query.mutate()}>
            Повторить чтение
          </Button>
        </Alert>
      )}
      {isDefined(documentData) && (
        <>
          <p className={styles.meta}>{metaItems.join(" · ")}</p>
          {isArchived && (
            <p className={styles.archived}>
              Материал в архиве: он сохранён, но может быть неактуален.
            </p>
          )}
          {hasSummary && <p className={styles.summary}>{documentData.summary}</p>}
          {isDefined(documentData.url) && (
            <Anchor
              href={documentData.url}
              target="_blank"
              rel="noreferrer noopener"
              className={styles.url}
            >
              {documentData.url}
              <ExternalLink size={13} aria-label="откроется в новой вкладке" />
            </Anchor>
          )}
          {isNonEmptyArray(tagList) && (
            <ul className={styles.tags} aria-label="Теги">
              {tagList.map((tag) => (
                <li key={tag} className={styles.tag}>
                  {tag}
                </li>
              ))}
            </ul>
          )}
          <MarkdownView className={styles.content} text={documentData.body} emptyText={emptyText} />
        </>
      )}
    </div>
  );
};
