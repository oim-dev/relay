import clsx from "clsx";
import type { PageStageProps } from "./types/page-stage-props.type";
import styles from "./styles/page-stage.module.css";

/**
 * Размещает содержимое экрана на светлой сцене поверх серой области экрана.
 * Блоки экрана лежат на сцене тонированными карточками.
 *
 * Используется для:
 *  - экранов-обзоров и каталогов с общим визуальным ритмом
 */
export const PageStage = (props: PageStageProps) => {
  const { children, className, ...rootAttrs } = props;
  return (
    <div className={styles.root}>
      <div {...rootAttrs} className={clsx(styles.stage, className)}>
        {children}
      </div>
    </div>
  );
};
