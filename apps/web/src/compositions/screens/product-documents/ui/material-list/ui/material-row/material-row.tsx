import { ActionIcon, Anchor, Checkbox, Highlight, Tooltip, VisuallyHidden } from "@mantine/core";
import { Eye, FileText, Link2, PencilLine, Pin } from "lucide-react";
import { Link } from "react-router-dom";
import { DOCUMENT_KINDS, DOCUMENT_STATUSES } from "domains/documents";
import { isNonEmptyArray } from "shared/value-predicates";
import { MaterialActions } from "../material-actions/material-actions";
import type { MaterialRowProps } from "./types/material-row-props.type";
import styles from "./styles/material-row.module.css";

/** Подсветка совпадений использует роль выделения темы, а не палитру. */
const HIGHLIGHT_STYLES = { color: "inherit", borderRadius: "0.1875rem", padding: "0 0.0625rem" };

/** Дата обновления: в текущем году без года, иначе полностью. */
const formatUpdated = (value: string): string => {
  const date = new Date(value);
  const isCurrentYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(
    "ru-RU",
    isCurrentYear
      ? { day: "numeric", month: "short" }
      : { day: "numeric", month: "numeric", year: "numeric" },
  );
};

/** Видимые теги строки; остальные сводятся в «+N». */
const VISIBLE_TAGS = 3;

/** Домен внешней ссылки без схемы и пути; при неразборчивом адресе — сам адрес. */
const getUrlHost = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * Показывает назначение, тип, состояние и использование материала одной строкой каталога.
 *
 * Используется для:
 *  - выбора материала в выдаче и перехода к его полной карточке
 *  - быстрого предпросмотра и редких изменений без открытия редактора
 */
export const MaterialRow = (props: MaterialRowProps) => {
  const { material, sectionName, href, returnTo, query, sections, isBusy } = props;
  const { isSelected, onOpen, onPreview, onChange, onSelectChange } = props;
  const data = material.document;
  const isLink = data.format === "link";
  const isDraft = data.status === "draft";
  const Icon = isLink ? Link2 : isDraft ? PencilLine : FileText;
  const summary = material.summary;
  const hasSummary = summary.trim() !== "";
  const excerpt = (data.excerpt ?? "")
    .replace(/[#>*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const hasExcerpt = excerpt !== "" && query !== "";
  const usageLabel = data.linkCount === 0 ? "без прикреплений" : `прикреплений: ${data.linkCount}`;
  const updatedFull = new Date(data.updatedAt).toLocaleString("ru-RU");
  const urlHost = isLink && data.url !== undefined ? getUrlHost(data.url) : "";
  const hasUrlHost = urlHost !== "";
  const tagItems = data.tags.slice(0, VISIBLE_TAGS);
  const hiddenTagCount = data.tags.length - tagItems.length;
  const hiddenTagsLabel = `+${hiddenTagCount}`;
  const hasHiddenTags = hiddenTagCount > 0;
  const hasTags = isNonEmptyArray(data.tags);
  return (
    <article
      className={styles.root}
      data-status={data.status}
      data-selected={isSelected}
      aria-busy={isBusy}
    >
      <Checkbox
        className={styles.check}
        size="sm"
        aria-label={`Выбрать: ${material.title}`}
        checked={isSelected}
        onChange={(event) => onSelectChange(event.currentTarget.checked)}
      />
      <span className={styles.icon} data-format={data.format}>
        <Icon size={18} strokeWidth={1.6} aria-hidden="true" />
      </span>
      <div className={styles.main}>
        <div className={styles.titleLine}>
          <Anchor
            component={Link}
            to={href}
            state={{ returnTo }}
            className={styles.title}
            data-material-link
            onClick={onOpen}
          >
            <Highlight
              component="span"
              inherit
              highlight={query}
              color="var(--tasks-search-mark)"
              highlightStyles={HIGHLIGHT_STYLES}
            >
              {material.title}
            </Highlight>
          </Anchor>
          {data.pinned && <Pin size={13} className={styles.pin} aria-label="Закреплён" />}
        </div>
        {hasSummary && (
          <Highlight
            component="p"
            className={styles.summary}
            highlight={query}
            color="var(--tasks-search-mark)"
            highlightStyles={HIGHLIGHT_STYLES}
          >
            {summary}
          </Highlight>
        )}
        {hasExcerpt && (
          <p className={styles.excerpt}>
            <span className={styles.excerptLabel}>В тексте: </span>
            <Highlight
              component="span"
              inherit
              highlight={query}
              color="var(--tasks-search-mark)"
              highlightStyles={HIGHLIGHT_STYLES}
            >
              {`…${excerpt}…`}
            </Highlight>
          </p>
        )}
        <p className={styles.meta}>
          <span className={styles.kind}>
            <VisuallyHidden>Тип: </VisuallyHidden>
            {DOCUMENT_KINDS[data.kind]}
          </span>
          {isLink && <span className={styles.format}>ссылка</span>}
          {hasUrlHost && (
            <span className={styles.domain} title={data.url}>
              <VisuallyHidden>Адрес: </VisuallyHidden>
              {urlHost}
            </span>
          )}
          <span className={styles.statusChip} data-status={data.status}>
            <VisuallyHidden>Состояние: </VisuallyHidden>
            {DOCUMENT_STATUSES[data.status]}
          </span>
          <span className={styles.section}>
            <VisuallyHidden>Раздел: </VisuallyHidden>
            {sectionName}
          </span>
          {hasTags && (
            <span className={styles.tags} title={data.tags.join(", ")}>
              <VisuallyHidden>Теги: </VisuallyHidden>
              {tagItems.map((tag) => (
                <Highlight
                  key={tag}
                  component="span"
                  className={styles.tag}
                  highlight={query}
                  color="var(--tasks-search-mark)"
                  highlightStyles={HIGHLIGHT_STYLES}
                >
                  {tag}
                </Highlight>
              ))}
              {hasHiddenTags && <span className={styles.tag}>{hiddenTagsLabel}</span>}
            </span>
          )}
        </p>
      </div>
      <p className={styles.facts}>
        <span className={styles.usage} data-empty={data.linkCount === 0}>
          {usageLabel}
        </span>
        <span className={styles.date}>
          <VisuallyHidden>Обновлён </VisuallyHidden>
          <time dateTime={data.updatedAt} title={updatedFull}>
            {formatUpdated(data.updatedAt)}
          </time>
        </span>
      </p>
      <div className={styles.actions}>
        <Tooltip label="Предпросмотр">
          <ActionIcon
            variant="subtle"
            color="gray"
            size="lg"
            aria-label={`Предпросмотр: ${material.title}`}
            aria-haspopup="dialog"
            onClick={onPreview}
          >
            <Eye size={17} aria-hidden="true" />
          </ActionIcon>
        </Tooltip>
        <MaterialActions
          title={material.title}
          isPinned={data.pinned}
          isArchived={data.status === "archived"}
          sectionId={data.sectionId}
          sections={sections}
          isBusy={isBusy}
          onChange={onChange}
        />
      </div>
    </article>
  );
};
