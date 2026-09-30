import { useId } from "react";
import clsx from "clsx";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { isDefined } from "shared/value-predicates";
import type { OverviewPanelProps } from "./types/overview-panel-props.type";
import styles from "./styles/overview-panel.module.css";

/**
 * Оформляет самостоятельную область обзора с заголовком, полным числом и переходом к разделу.
 * Уровень поверхности отделяет срочную работу от справочного контекста проекта.
 *
 * Используется для:
 *  - блоков задач, внимания, планов, релизов, досок, знаний и документов
 *  - обозначения ограниченной подборки и способа полного чтения
 */
export const OverviewPanel = (props: OverviewPanelProps) => {
  const {
    title,
    total,
    link,
    preview,
    tone = "primary",
    children,
    className,
    ...rootAttrs
  } = props;
  const titleId = useId();
  const hasMore = isDefined(preview) && preview.shown < preview.total;
  const previewNote = hasMore ? `Показано ${preview.shown} из ${preview.total}` : null;
  return (
    <section
      {...rootAttrs}
      className={clsx(styles.root, className)}
      data-tone={tone}
      aria-labelledby={titleId}
    >
      <header className={styles.header}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {isDefined(total) && <span className={styles.total}>{total}</span>}
        {isDefined(link) && (
          <Link to={link.to} className={styles.link}>
            {link.label}
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
        )}
      </header>
      {children}
      {isDefined(previewNote) && <p className={styles.note}>{previewNote}</p>}
    </section>
  );
};
