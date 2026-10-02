import { useEffect, useId, useRef, useState } from "react";
import clsx from "clsx";
import { Alert, Button, Drawer, Skeleton } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { Link, useLocation } from "react-router-dom";
import { BookOpen, Library, Plus } from "lucide-react";
import { MATERIAL_TARGET_KINDS, useEntityMaterials } from "domains/documents";
import { useProjectBasePath, useProjectId } from "domains/project";
import { isDefined, isEmptyArray } from "shared/value-predicates";
import { MaterialEntry } from "./ui/material-entry/material-entry";
import { MaterialPicker } from "./ui/material-picker";
import { MaterialPreview } from "./ui/material-preview/material-preview";
import type { EntityDocumentsProps } from "./types/entity-documents-props.type";
import styles from "./styles/entity-documents.module.css";

/** Время, за которое ловушка фокуса родительского диалога успевает восстановиться. */
const PARENT_TRAP_DELAY = 50;

/**
 * Показывает материалы библиотеки, прикреплённые непосредственно к сущности, и управляет
 * этими прикреплениями со стороны сущности: добавить из библиотеки, создать новый материал,
 * изменить тип связи и пояснение, открепить. Материалы родителя здесь не показываются.
 *
 * Используется для:
 *  - чтения контекста рядом с работой над любой из 11 адресуемых сущностей
 *  - прикрепления одного материала к нескольким сущностям без копий текста
 */
export const EntityDocuments = (props: EntityDocumentsProps) => {
  const { target, targetTitle, onOpenedChange, className, ...rootAttrs } = props;
  const projectId = useProjectId();
  const base = useProjectBasePath();
  const location = useLocation();
  const isWide = useMediaQuery("(min-width: 48em)");
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnTarget = useRef<HTMLElement | null>(null);
  const reference = `${target.kind}:${target.id}`;
  const response = useEntityMaterials(projectId, reference, null);
  const [isPickerOpened, setPickerOpened] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  /** Родительский диалог отпускает фокус с открытия окна блока до конца его закрытия. */
  const [isHoldingParent, setHoldingParent] = useState(false);
  useEffect(() => {
    if (!isHoldingParent) return;
    onOpenedChange?.(true);
    return () => onOpenedChange?.(false);
  }, [isHoldingParent, onOpenedChange]);
  useEffect(() => {
    setNotice("");
    setPreviewId(null);
    setPickerOpened(false);
  }, [projectId, reference]);
  const pages = response.data ?? [];
  const lastPage = pages.at(-1);
  const materialItems = pages.flatMap((page) => page.items);
  const total = pages[0]?.total ?? 0;
  const kindLabel = MATERIAL_TARGET_KINDS[target.kind];
  const targetLabel = isDefined(targetTitle) ? `${kindLabel} «${targetTitle}»` : kindLabel;
  const returnTo = `${location.pathname}${location.search}${location.hash}`;
  const createSearch = new URLSearchParams({
    attach: reference,
    relation: "references",
    return: returnTo,
  });
  const createHref = `${base}/documents/new?${createSearch.toString()}`;
  const previewMaterial = materialItems.find((item) => item.document.ref.id === previewId);
  const previewTitle = previewMaterial?.document.title ?? "Материал";
  const isFirstLoading = !isDefined(response.data) && !isDefined(response.error);
  const hasError = isDefined(response.error);
  const isEmpty = isEmptyArray(materialItems) && isDefined(response.data);
  const hasMore = isDefined(lastPage) && lastPage.nextOffset !== null;
  const isLoadingMore = response.isValidating && response.size > pages.length;
  const drawerSize = isWide ? "36rem" : "100%";
  /** Запоминает элемент, открывший окно блока. */
  const rememberTrigger = (): void => {
    setHoldingParent(true);
    returnTarget.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };
  /**
   * После завершения закрытия возвращает фокус к элементу, открывшему окно, и только затем
   * отпускает родительский диалог: он запоминает этот элемент для своего возврата фокуса.
   * Восстановленная ловушка родителя переводит фокус к первому элементу асинхронно,
   * поэтому фокус к источнику возвращается повторно после её срабатывания.
   */
  const restoreTrigger = (): void => {
    const node = returnTarget.current;
    returnTarget.current = null;
    const target = node?.isConnected === true ? node : headingRef.current;
    target?.focus();
    setHoldingParent(false);
    if (isDefined(onOpenedChange)) setTimeout(() => target?.focus(), PARENT_TRAP_DELAY);
  };
  /** Сообщает итог действия и переводит фокус к заголовку, если строка исчезла. */
  const handleDone = (message: string, shouldFocusHeading: boolean): void => {
    setNotice(message);
    if (shouldFocusHeading) headingRef.current?.focus();
  };
  return (
    <section {...rootAttrs} className={clsx(styles.root, className)} aria-labelledby={titleId}>
      <header className={styles.heading}>
        <div className={styles.titleGroup}>
          <h2 id={titleId} ref={headingRef} className={styles.title} tabIndex={-1}>
            <BookOpen size={17} aria-hidden="true" />
            Материалы
            <span className={styles.count}>{total}</span>
          </h2>
          <p className={styles.hint}>
            Прикреплены именно к этой записи: материалы родителя здесь не повторяются.
          </p>
        </div>
        <div className={styles.actions}>
          <Button
            size="sm"
            variant="light"
            leftSection={<Library size={14} aria-hidden="true" />}
            aria-haspopup="dialog"
            onClick={() => {
              setNotice("");
              rememberTrigger();
              setPickerOpened(true);
            }}
          >
            Добавить из библиотеки
          </Button>
          <Button
            component={Link}
            to={createHref}
            size="sm"
            variant="default"
            leftSection={<Plus size={14} aria-hidden="true" />}
          >
            Создать материал
          </Button>
        </div>
      </header>
      <p className={styles.notice} role="status" aria-live="polite">
        {notice}
      </p>
      {hasError && (
        <Alert color="orange" title="Не удалось прочитать материалы" className={styles.alert}>
          {response.error?.message}
          <Button
            size="xs"
            variant="subtle"
            mt="xs"
            onClick={() => void response.mutate().catch(() => undefined)}
          >
            Повторить чтение
          </Button>
        </Alert>
      )}
      {isFirstLoading && (
        <div className={styles.loading} aria-label="Загружаем материалы">
          <Skeleton height={64} radius="lg" />
          <Skeleton height={64} radius="lg" />
        </div>
      )}
      {isEmpty && (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Материалов пока нет</p>
          <p className={styles.emptyText}>
            Добавьте правила, спецификацию, решение или ссылку из библиотеки — они останутся рядом с
            работой. Одна запись может быть прикреплена к нескольким сущностям без копий.
          </p>
        </div>
      )}
      <ul className={styles.list} aria-label="Материалы сущности">
        {materialItems.map((material) => (
          <li key={material.document.ref.id}>
            <MaterialEntry
              material={material}
              target={target}
              href={`${base}/documents/${material.document.ref.id}`}
              returnTo={returnTo}
              onPreview={() => {
                rememberTrigger();
                setPreviewId(material.document.ref.id);
              }}
              onDone={handleDone}
            />
          </li>
        ))}
      </ul>
      {hasMore && (
        <Button
          variant="subtle"
          color="gray"
          size="xs"
          mt="sm"
          loading={isLoadingMore}
          onClick={() => void response.setSize(response.size + 1)}
        >
          Показать ещё материалы
        </Button>
      )}
      <MaterialPicker
        opened={isPickerOpened}
        target={target}
        targetLabel={targetLabel}
        onClose={() => setPickerOpened(false)}
        onExited={restoreTrigger}
        onAttached={(count) => setNotice(`Прикреплено материалов: ${count}.`)}
        renderPreview={(materialId) => (
          <MaterialPreview materialId={materialId} returnTo={returnTo} />
        )}
      />
      <Drawer
        opened={previewId !== null}
        position="right"
        size={drawerSize}
        title={previewTitle}
        closeButtonProps={{ "aria-label": "Закрыть предпросмотр" }}
        classNames={{ title: styles.drawerTitle, body: styles.drawerBody }}
        onClose={() => setPreviewId(null)}
        onExitTransitionEnd={restoreTrigger}
      >
        {previewId !== null && <MaterialPreview materialId={previewId} returnTo={returnTo} />}
      </Drawer>
    </section>
  );
};
