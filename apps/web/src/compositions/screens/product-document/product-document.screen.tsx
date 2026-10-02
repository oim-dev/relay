import { useCallback, useEffect, useRef, useState } from "react";
import { ActionIcon, Alert, Anchor, Button, Menu, Skeleton } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Check,
  Copy,
  FileText,
  Globe,
  MoreHorizontal,
  Pencil,
  PencilLine,
  Pin,
  PinOff,
} from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useProjectBasePath, useProjectId } from "domains/project";
import {
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  DocumentAccessError,
  DocumentConflictError,
  MATERIAL_FORMATS,
  useDocument,
  useLibrarySettings,
  useMaterialMutations,
} from "domains/documents";
import type { MaterialPropertyChanges } from "domains/documents";
import { getProductReturn } from "compositions/widgets/product-page";
import { EntityDelete } from "compositions/widgets/entity-delete";
import { DocumentRelations } from "compositions/widgets/document-relations";
import { EntityDocuments } from "compositions/widgets/entity-documents";
import { MarkdownView } from "ui/markdown-view";
import { PageStage } from "ui/page-stage";
import { StatePanel } from "ui/state-panel";
import { isDefined } from "shared/value-predicates";
import { DocumentContext } from "./ui/document-context";
import { LinkResource } from "./ui/link-resource/link-resource";
import styles from "./styles/product-document.module.css";

/** Отказ быстрого изменения свойств, показанный под шапкой. */
type ActionNotice = { tone: "warning" | "danger"; message: string };

/** Сообщение об успешном изменении свойств. */
const getSuccessMessage = (changes: MaterialPropertyChanges): string => {
  if (changes.pinned === true) return "Материал закреплён";
  if (changes.pinned === false) return "Материал откреплён";
  if (changes.documentStatus === "archived") return "Материал перенесён в архив";
  if (changes.documentStatus === "draft") return "Материал возвращён в черновики";
  return "Материал стал действующим";
};

/**
 * Карточка материала по постоянному адресу: назначение, содержание или внешний ресурс,
 * свойства, места использования и материалы, прикреплённые к самому материалу.
 *
 * Используется для:
 *  - чтения документа или перехода к внешнему ресурсу по явному действию
 *  - быстрого изменения закрепления и состояния без редактора
 *  - управления связями материала с сущностями проекта
 */
export const ProductDocumentScreen = () => {
  const { documentId } = useParams();
  const projectId = useProjectId();
  const base = useProjectBasePath();
  const location = useLocation();
  const navigate = useNavigate();
  const query = useDocument(projectId, documentId ?? null);
  const settings = useLibrarySettings(projectId);
  const { changeProperties } = useMaterialMutations(projectId);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const [isSaving, setSaving] = useState(false);
  const [defect, setDefect] = useState<Error>();
  const [outline, setOutline] = useState<{ id: string; title: string; level: number }[]>([]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const documentData = query.data;
  const backTo = getProductReturn(location.state, `${base}/documents`, base);
  const title = documentData?.name;
  useEffect(() => {
    if (!isDefined(title)) return;
    document.title = `${title} · Relay`;
  }, [title]);
  const focusedRef = useRef<string | null>(null);
  const isReady = isDefined(title);
  const hash = location.hash;
  useEffect(() => {
    // Фокус переводится на заголовок один раз для каждого материала, а не при обновлении данных.
    if (!isReady || focusedRef.current === documentId) return;
    focusedRef.current = documentId ?? null;
    if (hash === "") headingRef.current?.focus({ preventScroll: true });
  }, [isReady, documentId, hash]);
  /** Берёт оглавление из настоящих заголовков Markdown, исключая содержимое блоков кода. */
  const articleRef = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const headings = Array.from(node.querySelectorAll("h1, h2, h3"));
    setOutline(
      headings.map((heading, index) => {
        const id = `document-heading-${index}`;
        heading.id = id;
        heading.setAttribute("tabindex", "-1");
        return { id, title: heading.textContent ?? "", level: Number(heading.tagName.slice(1)) };
      }),
    );
  }, []);
  if (defect !== undefined) throw defect;
  /** Меняет свойство под прочитанной ревизией; конфликт не повторяется автоматически. */
  const handleChange = async (changes: MaterialPropertyChanges): Promise<void> => {
    if (!isDefined(documentData)) return;
    setSaving(true);
    setNotice(null);
    try {
      await changeProperties(documentData, changes, crypto.randomUUID());
      notifications.show({ message: getSuccessMessage(changes) });
    } catch (failure) {
      if (failure instanceof DocumentConflictError)
        setNotice({
          tone: "warning",
          message:
            "Материал изменили, пока вы его читали. Карточка обновлена — проверьте состояние и при необходимости повторите действие.",
        });
      else if (failure instanceof DocumentAccessError)
        setNotice({ tone: "danger", message: failure.message });
      else
        setDefect(failure instanceof Error ? failure : new Error("Не удалось изменить материал"));
    } finally {
      setSaving(false);
    }
  };
  /** Копирует постоянный адрес карточки. */
  const handleCopyLink = (): void => {
    void navigator.clipboard
      .writeText(window.location.href)
      .then(() => notifications.show({ message: "Ссылка на материал скопирована" }))
      .catch(() => setNotice({ tone: "danger", message: "Не удалось скопировать ссылку" }));
  };
  if (query.isLoading)
    return (
      <PageStage aria-busy="true">
        <Skeleton height={24} width={120} />
        <Skeleton height={48} />
        <Skeleton height={320} radius="xl" />
      </PageStage>
    );
  if (!isDefined(documentData))
    return (
      <StatePanel
        title="Материал недоступен"
        description={query.error?.message ?? "Материал не найден в этом проекте."}
        action={
          <Button variant="default" onClick={() => void query.mutate()}>
            Повторить чтение
          </Button>
        }
      />
    );
  const isLink = documentData.documentFormat === "link";
  const isDraft = documentData.documentStatus === "draft";
  const isArchived = documentData.documentStatus === "archived";
  const isProposal = documentData.documentKind === "proposal";
  const sectionName =
    settings.data?.sections.find((section) => section.id === documentData.sectionId)?.name ??
    "Без раздела";
  const editHref = `${base}/documents/${documentData.id}/edit`;
  const pinLabel = documentData.pinned ? "Открепить в библиотеке" : "Закрепить в библиотеке";
  const hasReadError = isDefined(query.error);
  const FormatIcon = isLink ? Globe : FileText;
  const pinIcon = documentData.pinned ? <PinOff size={14} /> : <Pin size={14} />;
  const shownOutline = isLink ? [] : outline;
  const content = isLink ? (
    <LinkResource url={documentData.url ?? ""} explanation={documentData.body} />
  ) : (
    <article
      key={documentData.body}
      ref={articleRef}
      className={styles.document}
      aria-label="Содержание материала"
    >
      <MarkdownView text={documentData.body} />
    </article>
  );
  const noticeColor = notice?.tone === "warning" ? "orange" : "red";
  return (
    <PageStage className={styles.stage}>
      <Anchor component={Link} to={backTo} className={styles.back}>
        <ArrowLeft size={15} aria-hidden="true" />
        Библиотека знаний
      </Anchor>
      <header className={styles.header}>
        <div className={styles.identity}>
          <div className={styles.chips}>
            <span className={styles.format} data-format={documentData.documentFormat}>
              <FormatIcon size={14} aria-hidden="true" />
              {MATERIAL_FORMATS[documentData.documentFormat]}
            </span>
            <span className={styles.chip}>{DOCUMENT_KINDS[documentData.documentKind]}</span>
            <span className={styles.chip} data-status={documentData.documentStatus}>
              {DOCUMENT_STATUSES[documentData.documentStatus]}
            </span>
            {documentData.pinned && (
              <span className={styles.chip}>
                <Pin size={12} aria-hidden="true" />
                Закреплён
              </span>
            )}
          </div>
          <h1 ref={headingRef} tabIndex={-1} className={styles.title}>
            {documentData.name}
          </h1>
          {documentData.summary !== "" && <p className={styles.summary}>{documentData.summary}</p>}
        </div>
        <div className={styles.actions}>
          <Button
            component={Link}
            to={editHref}
            state={{ returnTo: backTo }}
            radius="xl"
            variant="default"
            leftSection={<Pencil size={15} aria-hidden="true" />}
          >
            Редактировать
          </Button>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon
                variant="default"
                size={36}
                radius="xl"
                aria-label="Действия с материалом"
                loading={isSaving}
              >
                <MoreHorizontal size={18} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<Copy size={14} />} onClick={handleCopyLink}>
                Скопировать ссылку
              </Menu.Item>
              <Menu.Item
                leftSection={pinIcon}
                onClick={() => void handleChange({ pinned: !documentData.pinned })}
              >
                {pinLabel}
              </Menu.Item>
              {isDraft && (
                <Menu.Item
                  leftSection={<Check size={14} />}
                  onClick={() => void handleChange({ documentStatus: "active" })}
                >
                  Сделать действующим
                </Menu.Item>
              )}
              {!isDraft && !isArchived && (
                <Menu.Item
                  leftSection={<PencilLine size={14} />}
                  onClick={() => void handleChange({ documentStatus: "draft" })}
                >
                  Вернуть в черновики
                </Menu.Item>
              )}
              {isArchived && (
                <Menu.Item
                  leftSection={<ArchiveRestore size={14} />}
                  onClick={() => void handleChange({ documentStatus: "active" })}
                >
                  Вернуть из архива
                </Menu.Item>
              )}
              {!isArchived && (
                <Menu.Item
                  leftSection={<Archive size={14} />}
                  onClick={() => void handleChange({ documentStatus: "archived" })}
                >
                  В архив
                </Menu.Item>
              )}
            </Menu.Dropdown>
          </Menu>
          <EntityDelete
            kind="document"
            entityId={documentData.id}
            onDeleted={() => navigate(backTo, { replace: true })}
          />
        </div>
      </header>
      {isDefined(notice) && (
        <Alert
          color={noticeColor}
          role="alert"
          withCloseButton
          closeButtonLabel="Скрыть сообщение"
          onClose={() => setNotice(null)}
        >
          {notice.message}
        </Alert>
      )}
      {hasReadError && (
        <Alert color="orange" title="Не удалось обновить материал">
          Показана последняя прочитанная версия. {query.error?.message}
          <Button size="xs" variant="subtle" onClick={() => void query.mutate()}>
            Повторить чтение
          </Button>
        </Alert>
      )}
      {isDraft && isProposal && (
        <Alert color="yellow" title="Проект решения">
          Проектируется, ещё не принято. Чтобы принять решение, смените тип на «Решение» и сделайте
          материал действующим в редакторе.
        </Alert>
      )}
      {isArchived && (
        <Alert color="gray" title="Материал в архиве">
          Сохранён вместе со связями для восстановления контекста. Не используйте как действующий.
        </Alert>
      )}
      <div className={styles.layout}>
        <div className={styles.main}>
          {content}
          <DocumentRelations material={documentData} />
          <EntityDocuments
            target={{ kind: "document", id: documentData.id }}
            targetTitle={documentData.name}
          />
        </div>
        <DocumentContext document={documentData} sectionName={sectionName} outline={shownOutline} />
      </div>
    </PageStage>
  );
};
