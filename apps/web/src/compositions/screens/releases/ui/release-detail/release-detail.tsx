import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, Badge, Button, Group, Modal } from "@mantine/core";
import { ArrowLeft, Rocket, Pencil } from "lucide-react";
import {
  getReleaseSummary,
  RELEASE_STATUS_LABELS,
  RELEASE_STATUS_COLORS,
  saveRelease,
  useReleasesRefresh,
  ReleaseError,
} from "domains/releases";
import type { Release } from "domains/releases";
import { useProjectId } from "domains/project";
import { isDefined } from "shared/value-predicates";
import { MarkdownView } from "ui/markdown-view";
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
  const summary = getReleaseSummary(release);
  const isReleased = release.status === "released";
  const canEdit = !isReleased;
  const canRelease = release.status === "planned" && summary.canRelease;
  const isPlanned = release.status === "planned";
  const isCancelled = release.status === "cancelled";
  const isBlocked = isPlanned && !canRelease;
  const releaseDescriptionId = isBlocked ? "release-blockers" : undefined;
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

  useEffect(() => {
    document.title = `${release.title} · Relay`;
    headingRef.current?.focus({ preventScroll: true });
  }, [release.id, release.title]);

  /**
   * Фиксирует выбранный состав с исходной ревизией без автоматического повтора.
   */
  const handleRelease = async () => {
    if (!isDefined(releaseDraft) || isReleasing) return;
    setIsReleasing(true);
    setError(null);
    try {
      await saveRelease(projectId, releaseDraft);
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

  return (
    <div className={styles.root}>
      <Link to={`${basePath}/releases`} className={styles.back}>
        <ArrowLeft size={14} />
        Все релизы
      </Link>
      <header className={styles.heading}>
        <div className={styles.identity}>
          <div className={styles.meta}>
            <span className={styles.key}>{release.key}</span>
            <Badge
              color={RELEASE_STATUS_COLORS[release.status]}
              variant="light"
              className={styles.badge}
            >
              {RELEASE_STATUS_LABELS[release.status]}
            </Badge>
          </div>
          <h1 className={styles.title} tabIndex={-1} ref={headingRef}>
            {release.title}
          </h1>
          <p className={styles.summary}>{release.summary}</p>
        </div>
        <div className={styles.actions}>
          {canEdit && (
            <Button variant="default" leftSection={<Pencil size={14} />} onClick={() => onEdit()}>
              Изменить релиз
            </Button>
          )}
          {isPlanned && (
            <Button
              leftSection={<Rocket size={14} aria-hidden="true" />}
              disabled={!canRelease}
              aria-describedby={releaseDescriptionId}
              onClick={handleConfirm}
            >
              Выпустить релиз
            </Button>
          )}
        </div>
      </header>
      {isBlocked && (
        <Alert id="release-blockers" color="orange" mb="lg" title="Что нужно для выпуска">
          Завершите включённые планы и выполните все их задачи, критерии и зависимости. Сейчас
          готово {summary.ready} из {summary.total} планов. Откройте нужный план в составе ниже.
        </Alert>
      )}
      {isCancelled && (
        <Alert color="gray" mb="lg" title="Релиз отменён">
          Чтобы выпустить его, выберите статус «Запланирован» в редакторе и сохраните релиз.
        </Alert>
      )}
      <dl className={styles.facts}>
        <div>
          <dt>Версия</dt>
          <dd>{release.version}</dd>
        </div>
        <div>
          <dt>Плановая дата</dt>
          <dd>{plannedDate}</dd>
        </div>
        <div>
          <dt>Готовность состава</dt>
          <dd>
            {summary.ready} из {summary.total} планов
          </dd>
        </div>
        {isReleased && (
          <div>
            <dt>Выпущен</dt>
            <dd>{releasedDate}</dd>
          </div>
        )}
      </dl>
      {isReleased && (
        <Alert color="gray" mb="lg" title="Выпуск зафиксирован">
          Ниже показаны актуальные планы, включённые в этот релиз.
          <p>Автор: {release.releasedBy}</p>
        </Alert>
      )}
      {hasMissing && (
        <Alert color="orange" mb="lg" title="Уточните состав">
          Недоступных планов: {summary.missing}. Их отсутствие не означает готовность выпуска.
        </Alert>
      )}
      {hasDescription && (
        <section className={styles.description}>
          <MarkdownView text={release.description} compact />
        </section>
      )}
      <ReleaseContent release={release} basePath={basePath} onEdit={() => onEdit()} />
      <section className={styles.description}>
        <h2>Материалы релиза</h2>
        <EntityDocuments target={{ kind: "release", id: release.id }} />
      </section>
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
        <p>
          Выпустить «{releaseDraft?.title}», версия {releaseDraft?.version}? Будут зафиксированы
          статус, дата и автор выпуска выбранных планов.
        </p>
        <p>Сборка и развёртывание этим действием не запускаются.</p>
        {hasError && (
          <Alert color="red" title="Релиз не выпущен">
            {error}
          </Alert>
        )}
        <Group justify="flex-end" mt="lg">
          <Button variant="default" disabled={isReleasing} onClick={() => setReleaseDraft(null)}>
            Отмена
          </Button>
          <Button
            leftSection={<Rocket size={14} aria-hidden="true" />}
            loading={isReleasing}
            onClick={handleRelease}
          >
            Подтвердить выпуск
          </Button>
        </Group>
      </Modal>
    </div>
  );
};
