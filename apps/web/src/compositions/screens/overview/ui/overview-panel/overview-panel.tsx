import { useId } from "react";
import clsx from "clsx";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { isDefined } from "shared/value-predicates";
import type { OverviewPanelProps } from "./types/overview-panel-props.type";
import styles from "./styles/overview-panel.module.css";

/**
 * Оформляет самостоятельную область обзора с заголовком, полным числом и переходом к разделу.
 * Карточка лежит на светлой сцене экрана; её подблоки — ещё более светлые плитки.
 *
 * Используется для:
 *  - блоков задач, внимания, планов, релизов, досок, знаний и документов
 *  - обозначения ограниченной подборки и способа полного чтения
 */
export const OverviewPanel = (props: OverviewPanelProps) => {
  const {
    title,
    total,
    totalLabel,
    link,
    preview,
    description,
    tone = "default",
    children,
    className,
    ...rootAttrs
  } = props;
  const titleId = useId();
  const hasMore = isDefined(preview) && preview.shown < preview.total;
  const previewNote = hasMore ? `Показано ${preview.shown} из ${preview.total}` : null;
  const totalText = isDefined(totalLabel) ? `${totalLabel}: ${total}` : total;
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
        {isDefined(total) && <span className={styles.total}>{totalText}</span>}
        {isDefined(link) && (
          <Link to={link.to} className={styles.link}>
            {link.label}
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
        )}
      </header>
      {isDefined(description) && <p className={styles.description}>{description}</p>}
      {children}
      {isDefined(previewNote) && <p className={styles.note}>{previewNote}</p>}
    </section>
  );
};
