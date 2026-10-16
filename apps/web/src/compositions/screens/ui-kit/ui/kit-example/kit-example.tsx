import { useId } from "react";
import clsx from "clsx";
import type { KitExampleProps } from "./types/kit-example-props.type";
import styles from "./styles/kit-example.module.css";

/**
 * Показывает один вариант UI kit вместе с назначением, импортом и правилом выбора.
 *
 * Используется для:
 *  - справки разработчика и браузерной приёмки темы
 */
export const KitExample = (props: KitExampleProps) => {
  const {
    title,
    titleAs: Heading = "h3",
    purpose,
    importLine,
    rule,
    children,
    className,
    ...rootAttrs
  } = props;
  const titleId = useId();
  return (
    <article {...rootAttrs} className={clsx(styles.root, className)} aria-labelledby={titleId}>
      <Heading id={titleId} className={styles.title}>
        {title}
      </Heading>
      <dl className={styles.facts}>
        <dt className={styles.term}>Назначение</dt>
        <dd className={styles.value}>{purpose}</dd>
        <dt className={styles.term}>Импорт</dt>
        <dd className={styles.value}>
          <code className={styles.code}>{importLine}</code>
        </dd>
        <dt className={styles.term}>Выбор</dt>
        <dd className={styles.value}>{rule}</dd>
      </dl>
      <div className={styles.demo}>{children}</div>
    </article>
  );
};
