import clsx from "clsx";
import { isDefined } from "shared/value-predicates";
import type { PageHeaderProps } from "./types/page-header-props.type";
import styles from "./styles/page-header.module.css";

/**
 * Открывает страницу заголовком первого уровня, контекстом, пояснением и действиями.
 * При достаточной ширине действия стоят справа от заголовка, иначе — под ним.
 *
 * Используется для:
 *  - сводок, каталогов и страниц записи на общей сцене
 */
export const PageHeader = (props: PageHeaderProps) => {
  const {
    title,
    titleRef,
    meta,
    description,
    actions,
    actionsLayout = "stack",
    className,
    ...rootAttrs
  } = props;
  const titleTabIndex = isDefined(titleRef) ? -1 : undefined;
  return (
    <header {...rootAttrs} className={clsx(styles.root, className)} data-actions={actionsLayout}>
      <div className={styles.layout}>
        <div className={styles.identity}>
          {isDefined(meta) && <div className={styles.meta}>{meta}</div>}
          <h1 ref={titleRef} tabIndex={titleTabIndex} className={styles.title}>
            {title}
          </h1>
          {isDefined(description) && <div className={styles.description}>{description}</div>}
        </div>
        {isDefined(actions) && <div className={styles.actions}>{actions}</div>}
      </div>
    </header>
  );
};
