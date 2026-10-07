import { useState } from "react";
import { Button, Text, Modal, Anchor, Badge, Group, Alert } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { Link2, Plus, ArrowUpRight } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useProjectId, useProjectBasePath } from "domains/project";
import { useEntities, entityKindLabel, isRelocatedEntityKind } from "domains/entities";
import { documentEntityHref } from "domains/documents";
import { MarkdownView } from "ui/markdown-view";
import { isEmptyArray } from "shared/value-predicates";
import { RelationPicker } from "./ui/relation-picker";
import type { DocumentRelationsProps } from "./types/document-relations-props.type";
import styles from "./styles/document-relations.module.css";

/**
 * Объясняет, к чему относится документ, и применяет явный набор связей.
 *
 * Используется для:
 *  - чтения контекста рядом с документом
 *  - выбора отношений в сохранённом документе и локальном редакторе
 */
export const DocumentRelations = ({
  value,
  references = [],
  documentId,
  onChange,
  isDraft = false,
}: DocumentRelationsProps) => {
  const projectId = useProjectId();
  const base = useProjectBasePath();
  const location = useLocation();
  const [isOpened, setOpened] = useState(false);
  const [visibleCount, setVisibleCount] = useState(6);
  const isMobile = useMediaQuery("(max-width: 47.99em)");
  const refs = [...new Set(value.map((link) => `${link.target.kind}:${link.target.id}`))];
  const query = useEntities(projectId, { refs, limit: 100 });
  const referenceItems = query.data?.items ?? references;
  const relationItems = value.slice(0, visibleCount).map((relation) => {
    const entity = referenceItems.find(
      (entry) => entry.ref.kind === relation.target.kind && entry.ref.id === relation.target.id,
    );
    // Прежний адрес после миграции: карточки нет, это не потерянная сущность.
    const isRelocated = entity === undefined && isRelocatedEntityKind(relation.target.kind);
    return {
      ...relation,
      address: `${relation.target.kind}:${relation.target.id}:${relation.type}`,
      isRelocated,
      title: entity?.title ?? (isRelocated ? relation.target.id : "Сущность недоступна"),
      key: isRelocated ? "только чтение" : (entity?.key ?? relation.target.id),
      context: entity?.context,
      kind: entityKindLabel(relation.target.kind),
      href: entity
        ? documentEntityHref(base, entity)
        : `${base}/relations?root=${encodeURIComponent(`${relation.target.kind}:${relation.target.id}`)}`,
      label: relation.type === "documents" ? "Описывает" : "Для чтения",
      hasDescription: relation.description.trim() !== "",
      hasContext: entity?.context !== undefined,
    };
  });
  const hasNoRelations = isEmptyArray(value);
  const hasMore = value.length > visibleCount;
  const returnTo = `${location.pathname}${location.search}`;
  return (
    <section className={styles.root} aria-label="Прикрепления документа">
      <div className={styles.heading}>
        <h2 className={styles.title}>
          <Link2 size={16} aria-hidden="true" /> Прикреплено к <span>{value.length}</span>
        </h2>
        <Button
          variant="subtle"
          size="compact-xs"
          color="gray"
          leftSection={<Plus size={14} />}
          onClick={() => setOpened(true)}
        >
          Изменить
        </Button>
      </div>
      {hasNoRelations && (
        <div className={styles.empty}>
          <Text size="sm" c="dimmed">
            Пока ни к чему не прикреплён
          </Text>
          <Text size="xs" c="dimmed" mt={4}>
            Прикрепите к задаче, фиче или реализации, чтобы знание было под рукой.
          </Text>
          <Button variant="default" size="xs" mt="sm" onClick={() => setOpened(true)}>
            Прикрепить
          </Button>
        </div>
      )}
      {query.error !== undefined && (
        <Alert color="orange" title="Названия прикреплений не загружены">
          <Button variant="subtle" size="xs" onClick={() => void query.mutate()}>
            Повторить
          </Button>
        </Alert>
      )}
      <ul className={styles.list}>
        {relationItems.map((relation) => (
          <li key={relation.address} className={styles.relation}>
            <Group gap={6}>
              <span className={styles.kind}>{relation.kind}</span>
              <Badge size="xs" variant="light" color="gray" tt="none">
                {relation.label}
              </Badge>
            </Group>
            {relation.isRelocated && <span className={styles.link}>{relation.title}</span>}
            {!relation.isRelocated && (
              <Anchor
                component={Link}
                to={relation.href}
                state={{ returnTo }}
                className={styles.link}
                c="inherit"
              >
                {relation.title}
                <ArrowUpRight size={14} aria-hidden="true" />
              </Anchor>
            )}
            <span className={styles.key}>{relation.key}</span>
            {relation.hasContext && (
              <Text size="xs" c="dimmed">
                {relation.context}
              </Text>
            )}
            {relation.hasDescription && (
              <div className={styles.explanation}>
                <MarkdownView text={relation.description} compact />
              </div>
            )}
          </li>
        ))}
      </ul>
      {hasMore && (
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          mt="sm"
          onClick={() => setVisibleCount((count) => count + 10)}
        >
          Показать ещё
        </Button>
      )}
      <Modal.Root
        opened={isOpened}
        onClose={() => setOpened(false)}
        size={760}
        fullScreen={isMobile}
        centered
      >
        <Modal.Overlay />
        <Modal.Content>
          <Modal.Header role="presentation">
            <Modal.Title>Прикрепления документа</Modal.Title>
            <Modal.CloseButton aria-label="Отменить выбор прикреплений" />
          </Modal.Header>
          <Modal.Body>
            {isOpened && (
              <RelationPicker
                initial={value}
                documentId={documentId}
                isDraft={isDraft}
                onApply={onChange}
                onClose={() => setOpened(false)}
              />
            )}
          </Modal.Body>
        </Modal.Content>
      </Modal.Root>
    </section>
  );
};
