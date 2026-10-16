import clsx from "clsx";
import { Button } from "@mantine/core";
import { Link } from "react-router-dom";
import { useProjectBasePath } from "domains/project";
import { RunAttribution } from "domains/work-history";
import { MarkdownView } from "ui/markdown-view";
import { isDefined, isNonEmptyArray } from "shared/value-predicates";
import type { PointContextProps } from "./types/point-context-props.type";
import styles from "./styles/point-context.module.css";

/**
 * Открывает второстепенный контекст точки по явному запросу читателя.
 *
 * Используется для:
 *  - перехода к поручению, исходному намерению и связанным результатам
 *  - просмотра технических идентификаторов и полного снимка авторства
 */
export const PointContext = (props: PointContextProps) => {
  const { detail, onSelectPoint, className, ...rootAttrs } = props;
  const base = useProjectBasePath();
  const { checkpoint, session, point, run, previousRun } = detail;
  const referenceItems = (checkpoint?.references ?? []).map((reference) => ({
    id: `${reference.ref.kind}:${reference.ref.id}`,
    title: `${reference.key ?? reference.ref.id} · ${reference.title}`,
    href: `${base}/relations?root=${encodeURIComponent(`${reference.ref.kind}:${reference.ref.id}`)}`,
  }));
  const acceptedIds = checkpoint?.acceptedSessionIds ?? [];
  const intentId =
    checkpoint?.intentId ?? (point.kind === "session-created" ? session.originCheckpointId : null);
  const hasIntent = isDefined(intentId);
  const hasReferences = isNonEmptyArray(referenceItems);
  const hasAcceptance = isNonEmptyArray(acceptedIds);
  const hasAssignment = point.kind !== "session-created" && session.description.trim() !== "";
  const hasContext = hasAssignment || hasIntent || hasReferences || hasAcceptance;
  const hasPreviousRun = isDefined(previousRun);
  const identifierItems = [
    { label: "Адрес точки", value: point.id },
    { label: "Ветка", value: session.key },
    { label: "ID ветки", value: session.id },
    { label: "Ключ checkpoint", value: checkpoint?.key ?? "" },
    { label: "Участие автора", value: run?.key ?? "" },
    { label: "Предыдущее участие", value: previousRun?.key ?? "" },
    { label: "Клиент", value: run?.client ?? "" },
    { label: "Внешняя сессия", value: run?.sourceSessionId ?? "" },
  ].filter((field) => field.value !== "");

  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      {hasContext && (
        <details className={styles.details}>
          <summary className={styles.toggle}>Поручение и связанные материалы</summary>
          {hasAssignment && (
            <section className={styles.section}>
              <h3 className={styles.heading}>Поручение ветки</h3>
              <MarkdownView text={session.description} headingStartLevel={4} />
            </section>
          )}
          {hasIntent && (
            <Button
              variant="subtle"
              mih={44}
              onClick={() => onSelectPoint(`${intentId}:checkpoint`)}
            >
              Открыть исходное намерение
            </Button>
          )}
          {hasAcceptance && (
            <section className={styles.section}>
              <h3 className={styles.heading}>Явно принятые результаты</h3>
              <ul className={styles.list}>
                {acceptedIds.map((id) => (
                  <li key={id}>
                    <Button variant="subtle" mih={44} onClick={() => onSelectPoint(`${id}:closed`)}>
                      Результат ветки {id}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {hasReferences && (
            <section className={styles.section}>
              <h3 className={styles.heading}>Прикреплённые материалы</h3>
              <ul className={styles.list}>
                {referenceItems.map((reference) => (
                  <li key={reference.id}>
                    <Link to={reference.href} className={styles.link}>
                      {reference.title}
                    </Link>
                  </li>
                ))}
              </ul>
              <p className={styles.note}>
                Сохранённые подписи ссылок; переход открывает текущий контекст сущности.
              </p>
            </section>
          )}
        </details>
      )}
      <details className={styles.details}>
        <summary className={styles.toggle}>Авторство и технические сведения</summary>
        <section className={styles.section}>
          <h3 className={styles.heading}>Автор точки</h3>
          <RunAttribution run={run} />
        </section>
        {hasPreviousRun && (
          <section className={styles.section}>
            <h3 className={styles.heading}>Предыдущее участие</h3>
            <RunAttribution run={previousRun} />
          </section>
        )}
        <div className={styles.identifiers}>
          {identifierItems.map((field) => (
            <label key={field.label} className={styles.field}>
              {field.label}
              <input
                className={styles.identifier}
                readOnly
                value={field.value}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
          ))}
        </div>
      </details>
    </div>
  );
};
