import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, Anchor, Button, Group, Modal, Progress } from "@mantine/core";
import { ArrowLeft, Pencil, Rocket } from "lucide-react";
import {
  getReleaseSummary,
  RELEASE_STATUS_LABELS,
  RELEASE_STATUS_TONES,
  saveRelease,
  useReleasesRefresh,
  ReleaseError,
} from "domains/releases";
import type { Release } from "domains/releases";
import { useProjectId } from "domains/project";
import { isDefined } from "shared/value-predicates";
import { MarkdownView } from "ui/markdown-view";
import { PageHeader } from "ui/page-header";
import { SectionPanel } from "ui/section-panel";
import { StatusBadge } from "ui/status-badge";
import { ReleaseContent } from "./ui/release-content/release-content";
import { EntityDocuments } from "compositions/widgets/entity-documents";
import type { ReleaseDetailProps } from "./types/release-detail-props.type";
import styles from "./styles/release-detail.module.css";

/**
 * Показывает версию, собственный статус и выбранные результаты одного выпуска.
 *
 * Используется для:
 *  - чтения реквизитов выпуска и актуальных выбранных планов
 */
export const ReleaseDetail = (props: ReleaseDetailProps) => {
  const { release, basePath, onEdit } = props;
  const projectId = useProjectId();
  const refresh = useReleasesRefresh(projectId);
  const [releaseDraft, setReleaseDraft] = useState<Release | null>(null);
  const [isReleasing, setIsReleasing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shouldFocusReleased = useRef(false);
  const summary = getReleaseSummary(release);
  const isReleased = release.status === "released";
  const canEdit = !isReleased;
  const canRelease = release.status === "planned" && summary.canRelease;
  const isPlanned = release.status === "planned";
  const isCancelled = release.status === "cancelled";
  const isBlocked = isPlanned && !canRelease;
  const blockersId = useId();
  const releaseDescriptionId = isBlocked ? blockersId : undefined;
  const isConfirmationOpen = isDefined(releaseDraft);
  const hasError = isDefined(error);
  const hasDescription = release.description.trim() !== "";
  const dateFormatter = new Intl.DateTimeFormat("ru", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const plannedDate =
    release.plannedFor === ""
      ? "Не назначена"
      : dateFormatter.format(new Date(`${release.plannedFor}T12:00:00`));
  const releasedDate =
    release.releasedAt === null
      ? "Не зафиксирован"
      : dateFormatter.format(new Date(release.releasedAt));
  const hasMissing = summary.missing > 0;
  const hasSummary = release.summary.trim() !== "";
  const readinessLabel = `Готово планов: ${summary.ready} из ${summary.total} (${summary.percent}%)`;

  useEffect(() => {
    document.title = `${release.title} · Relay`;
  }, [release.title]);

  // Заголовок получает фокус при открытии релиза, а не при каждом обновлении его данных.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [release.id]);

  /*
   * После выпуска кнопка «Выпустить релиз» исчезает вместе со статусом «Запланирован»,
   * поэтому фокус переходит к заголовку выпуска со статусом «Выпущен».
   */
  useEffect(() => {
    if (!isReleased || !shouldFocusReleased.current) return;
    shouldFocusReleased.current = false;
    headingRef.current?.focus({ preventScroll: true });
  }, [isReleased]);

  /**
   * Фиксирует выбранный состав с исходной ревизией без автоматического повтора.
   */
  const handleRelease = async () => {
    if (!isDefined(releaseDraft) || isReleasing) return;
    setIsReleasing(true);
    setError(null);
    try {
      await saveRelease(projectId, releaseDraft);
      shouldFocusReleased.current = true;
      setReleaseDraft(null);
      void refresh().catch(() => undefined);
    } catch (error) {
      if (error instanceof ReleaseError) setError(error.message);
      else throw error;
    } finally {
      setIsReleasing(false);
    }
  };

  /**
   * Сохраняет реквизиты подтверждения отдельно от несохранённого редактора релиза.
   */
  const handleConfirm = () => {
    setError(null);
    setReleaseDraft({ ...release, status: "released" });
  };

  const headerDescription = hasSummary ? (
    <span className={styles.summary}>{release.summary}</span>
  ) : undefined;
  const headerActions =
    canEdit || isPlanned ? (
      <>
        {canEdit && (
          <Button
            variant="default"
            leftSection={<Pencil size={16} aria-hidden="true" />}
            onClick={() => onEdit()}
          >
            Изменить релиз
          </Button>
        )}
        {isPlanned && (
          <Button
            leftSection={<Rocket size={16} aria-hidden="true" />}
            data-disabled={!canRelease || undefined}
            aria-disabled={!canRelease || undefined}
            aria-describedby={releaseDescriptionId}
            onClick={(event) => {
              if (!canRelease) {
                event.preventDefault();
                return;
              }
              handleConfirm();
            }}
          >
            Выпустить релиз
          </Button>
        )}
      </>
    ) : undefined;

  return (
    <>
      <Anchor component={Link} to={`${basePath}/releases`} className={styles.back}>
        <ArrowLeft size={16} aria-hidden="true" />
        Все релизы
      </Anchor>
      <PageHeader
        title={release.title}
        titleRef={headingRef}
        meta={
          <>
            <span className={styles.key}>{release.key}</span>
            <span className={styles.version}>Версия {release.version}</span>
            <StatusBadge tone={RELEASE_STATUS_TONES[release.status]}>
              {RELEASE_STATUS_LABELS[release.status]}
            </StatusBadge>
          </>
        }
        description={headerDescription}
        actionsLayout="inline"
        actions={headerActions}
      />
      {isBlocked && (
        <Alert id={blockersId} color="warning" title="Что нужно для выпуска">
          Завершите включённые планы и выполните все их задачи, критерии и зависимости. Сейчас
          готово {summary.ready} из {summary.total} планов. Откройте нужный план в составе ниже.
        </Alert>
      )}
      {isCancelled && (
        <Alert color="gray" title="Релиз отменён">
          Чтобы выпустить его, выберите статус «Запланирован» в редакторе и сохраните релиз.
        </Alert>
      )}
      {isReleased && (
        <Alert color="gray" title="Выпуск зафиксирован">
          Ниже показаны актуальные планы, включённые в этот релиз.
        </Alert>
      )}
      {hasMissing && (
        <Alert color="warning" title="Уточните состав">
          Недоступных планов: {summary.missing}. Их отсутствие не означает готовность выпуска.
        </Alert>
      )}
      <div className={styles.layout}>
        <div className={styles.main}>
          {hasDescription && (
            <SectionPanel title="Описание выпуска">
              <MarkdownView text={release.description} compact />
            </SectionPanel>
          )}
          <ReleaseContent release={release} basePath={basePath} onEdit={() => onEdit()} />
          <EntityDocuments
            target={{ kind: "release", id: release.id }}
            targetTitle={release.title}
          />
        </div>
        <aside className={styles.aside} aria-label="Сведения о релизе">
          <SectionPanel title="Сведения о выпуске" density="compact" className={styles.factsPanel}>
            <div className={styles.readiness}>
              <p className={styles.readinessValue}>
                <strong>
                  {summary.ready} из {summary.total}
                </strong>
                <span>планов готовы сейчас</span>
              </p>
              <Progress variant="accent" value={summary.percent} aria-label={readinessLabel} />
            </div>
            <dl className={styles.facts}>
              <div>
                <dt>Версия</dt>
                <dd>{release.version}</dd>
              </div>
              <div>
                <dt>Плановая дата</dt>
                <dd>{plannedDate}</dd>
              </div>
              {isReleased && (
                <div>
                  <dt>Выпущен</dt>
                  <dd>{releasedDate}</dd>
                </div>
              )}
              {isReleased && isDefined(release.releasedBy) && (
                <div>
                  <dt>Автор выпуска</dt>
                  <dd>{release.releasedBy}</dd>
                </div>
              )}
            </dl>
          </SectionPanel>
        </aside>
      </div>
      <Modal
        attributes={{ header: { role: "presentation" } }}
        opened={isConfirmationOpen}
        onClose={() => {
          if (!isReleasing) setReleaseDraft(null);
        }}
        title="Выпустить релиз"
        closeOnClickOutside={!isReleasing}
        closeOnEscape={!isReleasing}
        withCloseButton={!isReleasing}
        closeButtonProps={{ "aria-label": "Закрыть подтверждение выпуска" }}
      >
        <div className={styles.confirm}>
          <p>
            Выпустить «{releaseDraft?.title}», версия {releaseDraft?.version}? Будут зафиксированы
            статус, дата и автор выпуска выбранных планов.
          </p>
          <p>Сборка и развёртывание этим действием не запускаются.</p>
          {hasError && (
            <Alert color="danger" title="Релиз не выпущен">
              {error}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" disabled={isReleasing} onClick={() => setReleaseDraft(null)}>
              Отмена
            </Button>
            <Button
              leftSection={<Rocket size={16} aria-hidden="true" />}
              loading={isReleasing}
              onClick={handleRelease}
            >
              Подтвердить выпуск
            </Button>
          </Group>
        </div>
      </Modal>
    </>
  );
};
