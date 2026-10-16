import clsx from "clsx";
import type { PageStageProps } from "./types/page-stage-props.type";
import styles from "./styles/page-stage.module.css";

/**
 * Задаёт геометрию и режим экрана на общей подложке приложения: вертикальный ритм,
 * зазор между самостоятельными панелями и рабочее поле на остаток высоты окна.
 * Собственной заливки не рисует — между панелями видна общая подложка.
 *
 * Используется для:
 *  - экранов-обзоров, каталогов и деталей с общим ритмом панелей
 *  - рабочих полей на всю доступную высоту окна (layout="workspace")
 */
export const PageStage = (props: PageStageProps) => {
  const { children, layout = "default", className, ...rootAttrs } = props;
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)} data-layout={layout}>
      {children}
    </div>
  );
};
