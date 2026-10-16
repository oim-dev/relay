import clsx from "clsx";
import { Link2 } from "lucide-react";
import type { AttachmentTargetProps } from "./types/attachment-target-props.type";
import styles from "./styles/attachment-target.module.css";

/**
 * Показывает, к какой сущности будет прикреплён новый материал, и принимает поля связи.
 *
 * Используется для:
 *  - создания материала из блока «Материалы» сущности с сохранением связи вместе с материалом
 */
export const AttachmentTarget = (props: AttachmentTargetProps) => {
  const { title, entityKey, kindLabel, children, className, ...rootAttrs } = props;
  return (
    <section
      {...rootAttrs}
      className={clsx(styles.root, className)}
      aria-labelledby="attachment-target-title"
    >
      <h2 id="attachment-target-title" className={styles.heading}>
        <Link2 size={16} aria-hidden="true" />
        Будет прикреплён к
      </h2>
      <div className={styles.target}>
        <span className={styles.kind}>{kindLabel}</span>
        <span className={styles.title}>{title}</span>
        <span className={styles.key}>{entityKey}</span>
      </div>
      {children}
    </section>
  );
};
