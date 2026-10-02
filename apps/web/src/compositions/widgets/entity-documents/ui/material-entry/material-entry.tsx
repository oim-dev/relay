import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import clsx from "clsx";
import { ActionIcon, Alert, Anchor, Button, Tooltip, VisuallyHidden } from "@mantine/core";
import { Link } from "react-router-dom";
import { Eye, FileText, Link2, Pencil, Pin, Unlink } from "lucide-react";
import {
  DOCUMENT_KINDS,
  DOCUMENT_RELATION_TYPES,
  DOCUMENT_STATUSES,
  DocumentConflictError,
  MATERIAL_FORMATS,
  useMaterialMutations,
} from "domains/documents";
import type { DocumentRelation } from "domains/documents";
import { useProjectId } from "domains/project";
import { MarkdownView } from "ui/markdown-view";
import { isDefined } from "shared/value-predicates";
import { describeRelationFailure } from "../../helpers/relation-failure";
import { RelationForm } from "../relation-form/relation-form";
import type { RelationFormValues } from "../relation-form/types/relation-form-props.type";
import type { MaterialEntryProps } from "./types/material-entry-props.type";
import styles from "./styles/material-entry.module.css";

/** Тип связи материала с сущностью. */
type RelationType = DocumentRelation["type"];

/**
 * Показывает один прикреплённый материал: название, формат, тип, состояние (архив явно)
 * и каждую его связь с сущностью — тип и пояснение «зачем читать здесь».
 * Изменяет и снимает связь одной записью relate под ревизией материала.
 *
 * Используется для:
 *  - строки блока «Материалы» сущности
 */
export const MaterialEntry = (props: MaterialEntryProps) => {
  const { material, target, href, returnTo, onPreview, onDone, className, ...rootAttrs } = props;
  const projectId = useProjectId();
  const { relate } = useMaterialMutations(projectId);
  const [editingType, setEditingType] = useState<RelationType | null>(null);
  const [detachingType, setDetachingType] = useState<RelationType | null>(null);
  const [isBusy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [defect, setDefect] = useState<unknown>();
  const triggers = useRef(new Map<string, HTMLButtonElement | null>());
  const pendingFocus = useRef<string | null>(null);
  /** Ревизия, прочитанная при открытии формы или подтверждения: запись идёт под ней. */
  const openedRevision = useRef<number | null>(null);
  const [, setFocusRequest] = useState(0);
  /**
   * Переводит фокус к запрошенной кнопке, как только она появилась: после смены типа
   * строка связи перерисовывается только по перечитанным данным.
   */
  useEffect(() => {
    const key = pendingFocus.current;
    if (key === null) return;
    const node = triggers.current.get(key);
    if (!isDefined(node)) return;
    node.focus();
    pendingFocus.current = null;
  });
  const summary = material.document;
  const data = summary.document;
  const format = data?.format ?? "markdown";
  const status = data?.status ?? "active";
  const isLink = format === "link";
  const isArchived = material.archived || status === "archived";
  const Icon = isLink ? Link2 : FileText;
  const kindLabel = isDefined(data) ? DOCUMENT_KINDS[data.kind] : "Материал";
  const statusLabel = DOCUMENT_STATUSES[status];
  const formatLabel = MATERIAL_FORMATS[format];
  const isPinned = data?.pinned === true;
  const hasSummary = summary.summary.trim() !== "";
  const presentTypes = material.relations.map((relation) => relation.type);
  const relationItems = material.relations.map((relation) => ({
    ...relation,
    label: DOCUMENT_RELATION_TYPES[relation.type],
    hasDescription: relation.description.trim() !== "",
    isLegacy: relation.source === "links",
    isEditing: editingType === relation.type,
    isDetaching: detachingType === relation.type,
    takenTypes: presentTypes.filter((type) => type !== relation.type),
  }));
  const hasError = error !== "";
  /** Возвращает фокус к кнопке, открывшей форму или подтверждение. */
  const restoreFocus = (key: string): void => {
    pendingFocus.current = key;
    setFocusRequest((value) => value + 1);
  };
  /** Выполняет одно изменение связи; ожидаемые отказы объясняются в строке. */
  const runRelate = async (
    change: Parameters<typeof relate>[1],
    successMessage: string,
    shouldFocusHeading: boolean,
  ): Promise<boolean> => {
    setBusy(true);
    setError("");
    try {
      await relate(
        { id: summary.ref.id, revision: openedRevision.current ?? summary.revision },
        change,
        crypto.randomUUID(),
      );
      onDone(successMessage, shouldFocusHeading);
      return true;
    } catch (failure) {
      const message = describeRelationFailure(failure);
      if (failure instanceof DocumentConflictError) openedRevision.current = null;
      if (isDefined(message)) setError(message);
      else setDefect(failure);
      return false;
    } finally {
      setBusy(false);
    }
  };
  /** Сохраняет тип и пояснение; неизменённый тип не передаётся. */
  const handleUpdate = async (type: RelationType, values: RelationFormValues): Promise<void> => {
    const isSaved = await runRelate(
      {
        action: "update",
        target,
        type,
        description: values.description,
        ...(values.type === type ? {} : { nextType: values.type }),
      },
      `Связь с материалом «${summary.title}» сохранена.`,
      false,
    );
    if (!isSaved) return;
    setEditingType(null);
    restoreFocus(`edit:${values.type}`);
  };
  /** Снимает одну связь: материал остаётся в библиотеке и у других сущностей. */
  const handleDetach = async (type: RelationType): Promise<void> => {
    const isLast = material.relations.length === 1;
    const isDone = await runRelate(
      { action: "detach", target, type },
      `Материал «${summary.title}» откреплён. Он остаётся в библиотеке.`,
      isLast,
    );
    if (!isDone) return;
    setDetachingType(null);
    if (!isLast) restoreFocus(`edit:${presentTypes.find((item) => item !== type) ?? type}`);
  };
  /** Escape в подтверждении отменяет открепление, не закрывая родительский диалог. */
  const handleConfirmKey = (event: KeyboardEvent<HTMLElement>, type: RelationType): void => {
    if (event.key !== "Escape" || isBusy) return;
    event.stopPropagation();
    setDetachingType(null);
    restoreFocus(`detach:${type}`);
  };
  if (isDefined(defect)) throw defect;
  return (
    <article
      {...rootAttrs}
      className={clsx(styles.root, className)}
      data-archived={isArchived}
      aria-busy={isBusy}
    >
      <div className={styles.head}>
        <span className={styles.icon} data-format={format}>
          <Icon size={17} strokeWidth={1.7} aria-hidden="true" />
        </span>
        <div className={styles.main}>
          <div className={styles.titleLine}>
            <Anchor component={Link} to={href} state={{ returnTo }} className={styles.title}>
              {summary.title}
            </Anchor>
            {isPinned && <Pin size={13} className={styles.pin} aria-label="Закреплён" />}
          </div>
          <p className={styles.meta}>
            <span className={styles.kind}>
              <VisuallyHidden>Тип: </VisuallyHidden>
              {kindLabel}
            </span>
            <span className={styles.format} data-format={format}>
              <VisuallyHidden>Формат: </VisuallyHidden>
              {formatLabel}
            </span>
            <span className={styles.status} data-status={status}>
              <VisuallyHidden>Состояние: </VisuallyHidden>
              {statusLabel}
            </span>
            <span className={styles.key}>{summary.key}</span>
          </p>
          {hasSummary && <p className={styles.summary}>{summary.summary}</p>}
          {isArchived && (
            <p className={styles.archived}>
              Материал в архиве: он сохранён, но может быть неактуален.
            </p>
          )}
        </div>
        <Tooltip label="Предпросмотр">
          <ActionIcon
            variant="subtle"
            color="gray"
            size="lg"
            aria-label={`Предпросмотр: ${summary.title}`}
            aria-haspopup="dialog"
            onClick={onPreview}
          >
            <Eye size={17} aria-hidden="true" />
          </ActionIcon>
        </Tooltip>
      </div>
      <ul
        className={styles.relations}
        aria-label={`Связи материала «${summary.title}» с сущностью`}
      >
        {relationItems.map((relation) => (
          <li key={relation.type} className={styles.relation}>
            <div className={styles.relationHead}>
              <span className={styles.relationType} data-type={relation.type}>
                {relation.label}
              </span>
              {relation.isLegacy && <span className={styles.legacy}>из продуктовой области</span>}
              <div className={styles.relationActions}>
                <Button
                  ref={(node) => {
                    triggers.current.set(`edit:${relation.type}`, node);
                  }}
                  size="compact-xs"
                  fz="xs"
                  variant="subtle"
                  color="gray"
                  leftSection={<Pencil size={12} aria-hidden="true" />}
                  aria-expanded={relation.isEditing}
                  disabled={isBusy}
                  onClick={() => {
                    setError("");
                    setDetachingType(null);
                    openedRevision.current = summary.revision;
                    setEditingType(relation.type);
                  }}
                >
                  Изменить
                  <VisuallyHidden>
                    {" "}
                    связь «{relation.label}» материала «{summary.title}»
                  </VisuallyHidden>
                </Button>
                <Button
                  ref={(node) => {
                    triggers.current.set(`detach:${relation.type}`, node);
                  }}
                  size="compact-xs"
                  fz="xs"
                  variant="subtle"
                  color="gray"
                  leftSection={<Unlink size={12} aria-hidden="true" />}
                  aria-expanded={relation.isDetaching}
                  disabled={isBusy}
                  onClick={() => {
                    setError("");
                    setEditingType(null);
                    openedRevision.current = summary.revision;
                    setDetachingType(relation.type);
                    restoreFocus(`confirm:${relation.type}`);
                  }}
                >
                  Открепить
                  <VisuallyHidden>
                    {" "}
                    связь «{relation.label}» материала «{summary.title}»
                  </VisuallyHidden>
                </Button>
              </div>
            </div>
            {relation.isEditing && (
              <RelationForm
                type={relation.type}
                description={relation.description}
                takenTypes={relation.takenTypes}
                isSubmitting={isBusy}
                onSubmit={(values) => handleUpdate(relation.type, values)}
                onCancel={() => {
                  setEditingType(null);
                  setError("");
                  restoreFocus(`edit:${relation.type}`);
                }}
              />
            )}
            {relation.isDetaching && (
              <div className={styles.confirm} role="group" aria-label="Подтверждение открепления">
                <p className={styles.confirmText}>
                  Открепить связь «{relation.label}»? Материал останется в библиотеке и у других
                  сущностей.
                </p>
                <div className={styles.confirmActions}>
                  <Button
                    size="xs"
                    color="red"
                    variant="light"
                    ref={(node) => {
                      triggers.current.set(`confirm:${relation.type}`, node);
                    }}
                    loading={isBusy}
                    onKeyDown={(event) => handleConfirmKey(event, relation.type)}
                    data-mantine-stop-propagation
                    onClick={() => void handleDetach(relation.type)}
                  >
                    Открепить
                  </Button>
                  <Button
                    size="xs"
                    variant="default"
                    disabled={isBusy}
                    onKeyDown={(event) => handleConfirmKey(event, relation.type)}
                    data-mantine-stop-propagation
                    onClick={() => {
                      setDetachingType(null);
                      restoreFocus(`detach:${relation.type}`);
                    }}
                  >
                    Отмена
                  </Button>
                </div>
              </div>
            )}
            {!relation.isEditing && relation.hasDescription && (
              <MarkdownView className={styles.description} text={relation.description} compact />
            )}
            {!relation.isEditing && !relation.hasDescription && (
              <p className={styles.noDescription}>
                Пояснение не задано: нажмите «Изменить», чтобы объяснить, зачем читать материал
                здесь.
              </p>
            )}
          </li>
        ))}
      </ul>
      {hasError && (
        <Alert color="orange" className={styles.error} role="alert">
          {error}
        </Alert>
      )}
    </article>
  );
};
