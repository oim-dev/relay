import clsx from "clsx";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { isDefined } from "shared/value-predicates";
import { SectionPanel } from "ui/section-panel";
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
    tone,
    children,
    className,
    ...rootAttrs
  } = props;
  const hasMore = isDefined(preview) && preview.shown < preview.total;
  const previewNote = hasMore ? `Показано ${preview.shown} из ${preview.total}` : null;
  const linkAction = isDefined(link) && (
    <Link to={link.to} className={styles.link}>
      {link.label}
      <ArrowRight size={14} aria-hidden="true" />
    </Link>
  );
  return (
    <SectionPanel
      {...rootAttrs}
      className={clsx(styles.root, className)}
      title={title}
      count={total}
      countLabel={totalLabel}
      actions={linkAction || undefined}
      description={description}
      tone={tone}
    >
      {children}
      {isDefined(previewNote) && <p className={styles.note}>{previewNote}</p>}
    </SectionPanel>
  );
};
