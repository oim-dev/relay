import { useEffect, useRef, useState } from "react";
import { Alert, Button, Group, Modal, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { Link2, Plus } from "lucide-react";
import { useLocation } from "react-router-dom";
import { useProjectBasePath, useProjectId } from "domains/project";
import { isRelocatedEntityKind, useEntities, useEntityRelocations } from "domains/entities";
import {
  DocumentAccessError,
  DocumentConflictError,
  DocumentRelationError,
  MATERIAL_TARGET_KINDS,
  useEntityHref,
  useMaterialMutations,
} from "domains/documents";
import type { MaterialTargetKind } from "domains/documents";
import { SectionPanel } from "ui/section-panel";
import { isDefined, isEmptyArray } from "shared/value-predicates";
import { describeRelocatedStage } from "./helpers/describe-relocated-stage";
import { parseRelationTarget } from "./helpers/parse-relation-target";
import { RelationForm } from "./ui/relation-form/relation-form";
import type { RelationFormValues } from "./ui/relation-form/types/relation-form-props.type";
import { RelationItem } from "./ui/relation-item/relation-item";
import type { DocumentRelationsProps } from "./types/document-relations-props.type";
import type { RelationEntry } from "./types/relation-entry.type";
import styles from "./styles/document-relations.module.css";

/** Порядок групп совпадает с перечнем видов сущностей проекта. */
const KIND_ORDER = Object.keys(MATERIAL_TARGET_KINDS) as MaterialTargetKind[];

/** Открытое изменение: прикрепление к новой сущности или правка одной связи. */
type Editing = { mode: "attach" } | { mode: "edit"; entry: RelationEntry };

/**
 * Показывает, где используется материал: прямые связи, сгруппированные по видам сущностей,
 * включая прежние области links. Каждая связь меняется и снимается отдельно под ревизией
 * материала; снятие не удаляет ни материал, ни сущность.
 *
 * Используется для:
 *  - перехода от материала к сущностям, для которых он нужен
 *  - прикрепления, изменения смысла и пояснения, открепления со стороны материала
 */
export const DocumentRelations = ({ material }: DocumentRelationsProps) => {
  const projectId = useProjectId();
  const base = useProjectBasePath();
  const location = useLocation();
  const { relate } = useMaterialMutations(projectId);
  const getEntityHref = useEntityHref(projectId, base);
  const isMobile = useMediaQuery("(max-width: 47.99em)");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [detaching, setDetaching] = useState<RelationEntry | null>(null);
  const [isDetachBusy, setDetachBusy] = useState(false);
  const [detachError, setDetachError] = useState("");
  const [defect, setDefect] = useState<Error>();
  /*
   * Ревизия, прочитанная при открытии окна: запись под ней не затирает чужое изменение,
   * пришедшее по SSE, пока человек вводил. После конфликта следующая попытка идёт
   * под перечитанной ревизией — человек уже увидел причину.
   */
  const openedRevisionRef = useRef<number | null>(null);
  const liveRevisionRef = useRef(material.revision);
  const headingRef = useRef<HTMLHeadingElement>(null);
  /* Адрес снятой связи, пока фокус ещё не перенесён с исчезающей строки на заголовок блока. */
  const detachedAddressRef = useRef<string | null>(null);
  useEffect(() => {
    liveRevisionRef.current = material.revision;
  }, [material.revision]);
  const allRelations = [
    ...material.relations.map((relation) => ({ relation, isLegacy: false })),
    ...material.legacyLinks.map((relation) => ({ relation, isLegacy: true })),
  ];
  const refs = [
    ...new Set(allRelations.map(({ relation }) => `${relation.target.kind}:${relation.target.id}`)),
  ];
  const relocatedRefs = allRelations
    .filter(({ relation }) => isRelocatedEntityKind(relation.target.kind))
    .map(({ relation }) => `${relation.target.kind}:${relation.target.id}`);
  const entities = useEntities(projectId, { refs, limit: 100 });
  // Владельца прежнего адреса называет Core в ответе на его разрешение.
  const relocations = useEntityRelocations(projectId, relocatedRefs);
  const known = entities.data?.items ?? material.references;
  const entryItems: RelationEntry[] = allRelations.map(({ relation, isLegacy }) => {
    const { kind, id } = relation.target;
    const address = `${kind}:${id}:${relation.type}:${isLegacy ? "links" : "relations"}`;
    const entity = known.find((item) => item.ref.kind === kind && item.ref.id === id);
    // Прежний адрес после миграции: карточки нет, это не потерянная сущность.
    const isRelocated = entity === undefined && isRelocatedEntityKind(kind);
    if (!isRelocated)
      return {
        address,
        relation,
        isLegacy,
        isRelocated,
        title: entity?.title ?? "Сущность недоступна",
        entityKey: entity?.key ?? id,
        href: isDefined(entity) ? getEntityHref(entity) : null,
        owner: null,
      };
    const relocation = relocations.get(`${kind}:${id}`);
    // Название плана берётся только из уже прочитанных карточек, без отдельного запроса.
    const plan = isDefined(relocation)
      ? known.find(
          (item) => item.ref.kind === relocation.owner.kind && item.ref.id === relocation.owner.id,
        )
      : undefined;
    const text = describeRelocatedStage(relocation, plan?.title);
    const ownerHref = isDefined(plan)
      ? getEntityHref(plan)
      : relocation?.owner.kind === "work-plan"
        ? `${base}/plans/${encodeURIComponent(relocation.owner.id)}`
        : null;
    return {
      address,
      relation,
      isLegacy,
      isRelocated,
      title: text.title,
      entityKey: null,
      href: null,
      owner: ownerHref === null ? null : { href: ownerHref, label: text.ownerLinkLabel },
    };
  });
  const entryAddresses = entryItems.map((entry) => entry.address).join("\n");
  /** Переводит фокус со снятой связи на заголовок блока, а не в body. */
  const focusAfterDetach = (): void => {
    if (detachedAddressRef.current === null) return;
    detachedAddressRef.current = null;
    headingRef.current?.focus();
  };
  /*
   * Строка снятой связи может исчезнуть раньше окончания анимации окна: возврат фокуса
   * Mantine тогда попадает на удалённую кнопку «Открепить» и теряется в body.
   */
  useEffect(() => {
    const address = detachedAddressRef.current;
    if (address === null || detaching !== null) return;
    if (entryAddresses.split("\n").includes(address)) return;
    detachedAddressRef.current = null;
    headingRef.current?.focus();
  }, [entryAddresses, detaching]);
  const groupItems = KIND_ORDER.map((kind) => ({
    kind,
    label: MATERIAL_TARGET_KINDS[kind],
    entries: entryItems.filter((entry) => entry.relation.target.kind === kind),
  })).filter((group) => !isEmptyArray(group.entries));
  const total = entryItems.length;
  const hasNoRelations = total === 0;
  const hasLoadError = isDefined(entities.error);
  const returnTo = `${location.pathname}${location.search}`;
  const editedEntry = editing?.mode === "edit" ? editing.entry : undefined;
  const dialogTitle = editing?.mode === "edit" ? "Связь материала" : "Прикрепить к сущности";
  if (defect !== undefined) throw defect;

  /** Открывает окно изменения, запоминая прочитанную ревизию. */
  const openEditing = (next: Editing): void => {
    openedRevisionRef.current = material.revision;
    setEditing(next);
  };
  /** Ревизия записи: прочитанная при открытии окна либо перечитанная после конфликта. */
  const getRevision = () => ({
    id: material.id,
    revision: openedRevisionRef.current ?? liveRevisionRef.current,
  });
  /** Выполняет изменение связи; при конфликте следующая попытка идёт под актуальной ревизией. */
  const relateOnce = async (change: Parameters<typeof relate>[1]): Promise<void> => {
    try {
      await relate(getRevision(), change, crypto.randomUUID());
    } catch (failure) {
      if (failure instanceof DocumentConflictError) openedRevisionRef.current = null;
      throw failure;
    }
  };

  /** Записывает одну связь под ревизией материала; отказ остаётся в форме. */
  const handleSubmit = async (values: RelationFormValues): Promise<void> => {
    if (editing === null) return;
    if (editing.mode === "attach") {
      const target = parseRelationTarget(values.target ?? "");
      if (target === null) return;
      await relateOnce({
        action: "attach",
        target,
        type: values.type,
        description: values.description,
      });
      notifications.show({ message: "Материал прикреплён" });
    } else {
      const { relation } = editing.entry;
      await relateOnce({
        action: "update",
        target: relation.target,
        type: relation.type,
        description: values.description,
        ...(values.type === relation.type ? {} : { nextType: values.type }),
      });
      notifications.show({ message: "Связь сохранена" });
    }
    setEditing(null);
  };

  /** Снимает одну связь; материал и сущность сохраняются. */
  const handleDetach = async (): Promise<void> => {
    if (detaching === null) return;
    setDetachBusy(true);
    setDetachError("");
    try {
      const { relation } = detaching;
      await relateOnce({ action: "detach", target: relation.target, type: relation.type });
      notifications.show({ message: `Материал откреплён от «${detaching.title}»` });
      detachedAddressRef.current = detaching.address;
      setDetaching(null);
    } catch (failure) {
      if (failure instanceof DocumentRelationError && failure.code === "RELATION_NOT_FOUND") {
        detachedAddressRef.current = detaching.address;
        setDetaching(null);
      } else if (failure instanceof DocumentConflictError)
        setDetachError(
          "Материал изменили, пока вы работали. Связи перечитаны — проверьте и подтвердите снова.",
        );
      else if (failure instanceof DocumentAccessError) setDetachError(failure.message);
      else setDefect(failure instanceof Error ? failure : new Error("Не удалось снять связь"));
    } finally {
      setDetachBusy(false);
    }
  };

  return (
    <SectionPanel
      title="Где используется"
      titleRef={headingRef}
      count={total}
      actions={
        <Button
          size="compact-sm"
          variant="default"
          leftSection={<Plus size={14} aria-hidden="true" />}
          onClick={() => openEditing({ mode: "attach" })}
        >
          Прикрепить
        </Button>
      }
    >
      {hasLoadError && (
        <Alert color="warning" title="Названия сущностей не загружены">
          <Button size="xs" variant="subtle" color="gray" onClick={() => void entities.mutate()}>
            Повторить
          </Button>
        </Alert>
      )}
      {hasNoRelations && (
        <div className={styles.empty}>
          <Link2 size={18} aria-hidden="true" />
          <Text size="sm" c="dimmed">
            Материал пока ни к чему не прикреплён. Прикрепите его к задаче, фиче или другой
            сущности, чтобы он был под рукой там, где нужен.
          </Text>
        </div>
      )}
      {groupItems.map((group) => (
        <div key={group.kind} className={styles.group}>
          <h3 className={styles.groupTitle}>
            {group.label}
            <span className={styles.groupCount} aria-hidden="true">
              {group.entries.length}
            </span>
          </h3>
          <ul className={styles.list}>
            {group.entries.map((entry) => (
              <RelationItem
                key={entry.address}
                entry={entry}
                returnTo={returnTo}
                onEdit={() => openEditing({ mode: "edit", entry })}
                onDetach={() => {
                  setDetachError("");
                  openedRevisionRef.current = material.revision;
                  setDetaching(entry);
                }}
              />
            ))}
          </ul>
        </div>
      ))}
      <Modal
        opened={editing !== null}
        onClose={() => setEditing(null)}
        title={dialogTitle}
        size="lg"
        fullScreen={isMobile}
        centered
        closeButtonProps={{ "aria-label": "Закрыть без сохранения" }}
      >
        {editing !== null && (
          <RelationForm
            projectId={projectId}
            entry={editedEntry}
            onSubmit={handleSubmit}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>
      <Modal
        opened={detaching !== null}
        onClose={() => setDetaching(null)}
        onExitTransitionEnd={focusAfterDetach}
        title="Открепить материал?"
        centered
        closeButtonProps={{ "aria-label": "Не откреплять" }}
      >
        <Text size="sm">
          Связь с «{detaching?.title}» будет снята. Материал и сущность сохранятся, остальные связи
          не изменятся.
        </Text>
        {detachError !== "" && (
          <Alert color="warning" role="alert" mt="md">
            {detachError}
          </Alert>
        )}
        <Group justify="flex-end" gap="xs" mt="lg">
          <Button variant="default" onClick={() => setDetaching(null)} disabled={isDetachBusy}>
            Отмена
          </Button>
          <Button color="danger" loading={isDetachBusy} onClick={() => void handleDetach()}>
            Открепить
          </Button>
        </Group>
      </Modal>
    </SectionPanel>
  );
};
