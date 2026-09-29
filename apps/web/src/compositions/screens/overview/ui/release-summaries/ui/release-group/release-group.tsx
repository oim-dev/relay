import { useId } from "react";
import clsx from "clsx";
import { isDefined, isEmptyArray, isNonEmptyArray } from "shared/value-predicates";
import { ReleaseItem } from "../release-item/release-item";
import type { ReleaseGroupProps } from "./types/release-group-props.type";
import styles from "./styles/release-group.module.css";

/**
 * Показывает подборку релизов с полным числом и пустым состоянием.
 *
 * Используется для:
 *  - ближайших запланированных и последних выпущенных релизов
 */
export const ReleaseGroup = (props: ReleaseGroupProps) => {
  const { title, emptyText, preview, basePath, className, ...rootAttrs } = props;
  const headingId = useId();
  const releaseItems = preview.items;
  const emptyNote = isEmptyArray(releaseItems) ? emptyText : null;
  const moreNote = preview.hasMore ? `Показано ${releaseItems.length} из ${preview.total}` : null;
  return (
    <section {...rootAttrs} className={clsx(styles.root, className)} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.title}>
        {title}
        <span className={styles.count}>{preview.total}</span>
      </h3>
      {isNonEmptyArray(releaseItems) && (
        <ul className={styles.list}>
          {releaseItems.map((release) => (
            <li key={release.id}>
              <ReleaseItem release={release} basePath={basePath} />
            </li>
          ))}
        </ul>
      )}
      {isDefined(emptyNote) && <p className={styles.note}>{emptyNote}</p>}
      {isDefined(moreNote) && <p className={styles.note}>{moreNote}</p>}
    </section>
  );
};
