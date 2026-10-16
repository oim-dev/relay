import { useId } from "react";
import clsx from "clsx";
import { isDefined } from "shared/value-predicates";
import type { SectionPanelProps } from "./types/section-panel-props.type";
import styles from "./styles/section-panel.module.css";

/**
 * Группирует связанное содержимое экрана в панель с заголовком, числом и действиями.
 * Панель — именованная область (`section` с заголовком); данные и переходы задаёт владелец.
 *
 * Используется для:
 *  - блоков сводки и выдачи каталога на сцене страницы
 *  - главной панели экрана с декоративным градиентом поверх сплошной основы
 */
export const SectionPanel = (props: SectionPanelProps) => {
  const {
    title,
    titleAs: Heading = "h2",
    titleRef,
    count,
    countLabel,
    actions,
    description,
    tone = "default",
    density = "default",
    children,
    className,
    ...rootAttrs
  } = props;
  const titleId = useId();
  const titleTabIndex = isDefined(titleRef) ? -1 : undefined;
  const countText = isDefined(countLabel) ? (
    <>
      {countLabel}: {count}
    </>
  ) : (
    count
  );
  return (
    <section
      {...rootAttrs}
      className={clsx(styles.root, className)}
      data-tone={tone}
      data-density={density}
      aria-labelledby={titleId}
    >
      <header className={styles.header}>
        <Heading id={titleId} ref={titleRef} tabIndex={titleTabIndex} className={styles.title}>
          {title}
        </Heading>
        {isDefined(count) && <span className={styles.count}>{countText}</span>}
        {isDefined(actions) && <div className={styles.actions}>{actions}</div>}
      </header>
      {isDefined(description) && <div className={styles.description}>{description}</div>}
      {children}
    </section>
  );
};
