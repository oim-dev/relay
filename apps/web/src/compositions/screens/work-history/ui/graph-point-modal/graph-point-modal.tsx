import { Button, Modal } from "@mantine/core";
import { useEffect, useRef } from "react";
import { useMediaQuery } from "@mantine/hooks";
import { Link } from "react-router-dom";
import { useProjectBasePath } from "domains/project";
import {
  useWorkGraphPoint,
  getWorkPointPresentation,
  formatWorkTime,
  RunAttribution,
  WorkAuthorAvatar,
} from "domains/work-history";
import { MarkdownView } from "ui/markdown-view";
import { isDefined, isNonEmptyArray } from "shared/value-predicates";
import { getPointMaterials } from "./helpers/point-materials";
import { BranchPoints } from "compositions/screens/work-history/ui/graph-point-modal/ui/branch-points";
import type { GraphPointModalProps } from "./types/graph-point-modal-props.type";
import styles from "./styles/graph-point-modal.module.css";

/**
 * Открывает полные материалы одной выбранной точки по отдельному чтению.
 *
 * Используется для:
 *  - централизованного просмотра Markdown и адресов checkpoint или lifecycle
 *  - мобильного полноэкранного чтения без изменения масштаба и области графа
 */
export const GraphPointModal = (props: GraphPointModalProps) => {
  const { projectId, pointRef, onClose, onSelectPoint } = props;
  const query = useWorkGraphPoint(projectId, pointRef);
  const isMobile = useMediaQuery("(max-width: 47.99em)");
  const base = useProjectBasePath();
  const detail = query.data;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const loadedPointId = detail?.point.id;
  useEffect(() => {
    if (loadedPointId === undefined) return;
    contentRef.current?.scrollTo({ top: 0 });
    titleRef.current?.focus({ preventScroll: true });
  }, [loadedPointId]);
  const hasError = isDefined(query.error);
  const title = detail?.point.title ?? "Открываем точку";
  const presentation =
    detail === undefined
      ? null
      : getWorkPointPresentation(detail.point, detail.run, detail.session);
  const kindLabel = presentation?.label ?? "Материалы точки";
  const timeLabel = detail === undefined ? "" : formatWorkTime(detail.point.at);
  const fields = detail === undefined ? [] : getPointMaterials(detail);
  const checkpoint = detail?.checkpoint;
  const summary = checkpoint?.summary ?? "";
  const hasSummary = summary.trim() !== "";
  const references = (checkpoint?.references ?? []).map((reference) => ({
    ...reference,
    id: `${reference.ref.kind}:${reference.ref.id}`,
    href: `${base}/relations?root=${encodeURIComponent(`${reference.ref.kind}:${reference.ref.id}`)}`,
  }));
  const acceptedIds = checkpoint?.acceptedSessionIds ?? [];
  const hasReferences = isNonEmptyArray(references);
  const hasAcceptance = isNonEmptyArray(acceptedIds);
  const intentId =
    checkpoint?.intentId ??
    (detail?.point.kind === "session-created" ? detail.session.originCheckpointId : null);
  const hasIntent = intentId !== null;
  const hasAssignment =
    detail !== undefined &&
    detail.point.kind !== "session-created" &&
    detail.session.description.trim() !== "";
  const identifiers =
    detail === undefined
      ? []
      : [
          { label: "Адрес точки", value: detail.point.id },
          { label: "Ветка", value: detail.session.key },
          { label: "ID ветки", value: detail.session.id },
          { label: "Ключ checkpoint", value: detail.checkpoint?.key ?? "" },
          { label: "Участие автора", value: detail.run?.key ?? "" },
          { label: "Предыдущее участие", value: detail.previousRun?.key ?? "" },
          { label: "Клиент", value: detail.run?.client ?? "" },
          { label: "Внешняя сессия", value: detail.run?.sourceSessionId ?? "" },
        ].filter((field) => field.value !== "");
  return (
    <Modal.Root
      opened
      centered
      size="lg"
      fullScreen={isMobile}
      onClose={onClose}
      returnFocus={false}
      classNames={{ content: styles.root }}
    >
      <Modal.Overlay />
      <Modal.Content ref={contentRef}>
        <Modal.Header role="presentation">
          <Modal.Title>{kindLabel}</Modal.Title>
          <Modal.CloseButton aria-label="Закрыть материал точки" />
        </Modal.Header>
        <Modal.Body>
          <h2 ref={titleRef} className={styles.title} tabIndex={-1} data-autofocus>
            {title}
          </h2>
          {query.isLoading && <p role="status">Читаем полный материал…</p>}
          {hasError && (
            <div role="alert">
              <p>{query.error?.message}</p>
              <Button variant="default" onClick={() => void query.mutate().catch(() => undefined)}>
                Повторить чтение точки
              </Button>
            </div>
          )}
          {isDefined(detail) && (
            <div className={styles.content}>
              <p className={styles.meta}>
                {timeLabel} · {detail.session.title}
              </p>
              <div className={styles.author}>
                <WorkAuthorAvatar operator={detail.run?.operator ?? null} size={44} />
                <RunAttribution run={detail.run} />
              </div>
              {isDefined(detail.previousRun) && (
                <p className={styles.meta}>
                  Предыдущее участие: {detail.previousRun.actor} ·{" "}
                  {detail.previousRun.operator?.name ?? "Пользователь не указан"}. Передача
                  сохраняет прежнего автора.
                </p>
              )}
              {hasSummary && <p className={styles.summary}>{summary}</p>}
              <BranchPoints
                key={detail.session.id}
                projectId={projectId}
                sessionId={detail.session.id}
                selectedPointId={detail.point.id}
                onSelectPoint={onSelectPoint}
              />
              {fields.map((field) => (
                <section key={field.label} className={styles.material}>
                  <h3>{field.label}</h3>
                  <MarkdownView text={field.text} headingStartLevel={4} />
                </section>
              ))}
              {hasIntent && (
                <Button variant="subtle" onClick={() => onSelectPoint(`${intentId}:checkpoint`)}>
                  Открыть исходное намерение
                </Button>
              )}
              {hasAcceptance && (
                <section className={styles.material}>
                  <h3>Явно принятые результаты</h3>
                  <ul>
                    {acceptedIds.map((id) => (
                      <li key={id}>
                        <Button variant="subtle" onClick={() => onSelectPoint(`${id}:closed`)}>
                          Открыть результат дочерней ветки
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {hasReferences && (
                <section className={styles.material}>
                  <h3>Прикреплённые материалы</h3>
                  <ul>
                    {references.map((reference) => (
                      <li key={reference.id}>
                        <Link to={reference.href}>
                          {reference.key ?? reference.id} · {reference.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                  <p className={styles.meta}>
                    Сохранённые подписи ссылок; переход открывает текущий контекст сущности.
                  </p>
                </section>
              )}
              {hasAssignment && (
                <details className={styles.details}>
                  <summary>Поручение ветки</summary>
                  <MarkdownView text={detail.session.description} headingStartLevel={3} />
                </details>
              )}
              <details className={styles.details}>
                <summary>Адреса и подключение</summary>
                <div className={styles.identifiers}>
                  {identifiers.map((field) => (
                    <label key={field.label}>
                      {field.label}
                      <input
                        readOnly
                        value={field.value}
                        onFocus={(event) => event.currentTarget.select()}
                      />
                    </label>
                  ))}
                </div>
              </details>
            </div>
          )}
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
};
