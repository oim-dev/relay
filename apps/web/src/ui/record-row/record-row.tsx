import type { ReactNode } from "react";
import clsx from "clsx";
import { isDefined } from "shared/value-predicates";
import type { RecordRowProps } from "./types/record-row-props.type";
import styles from "./styles/record-row.module.css";

/** Слот заполнен: false из условного выражения владельца считается пустым. */
const isFilled = (slot: ReactNode): boolean => isDefined(slot) && slot !== false;

/**
 * Показывает одну запись списка плиткой: ключ, название-ссылку, пояснения и состояние.
 * Данные, переходы и действия задаёт владелец; строка не является кнопкой.
 *
 * Используется для:
 *  - выдачи каталога материалов с выбором и действиями
 *  - списков задач и зависимостей на страницах продукта
 */
export const RecordRow = (props: RecordRowProps) => {
  const {
    title,
    code,
    leading,
    meta,
    trailing,
    selected = false,
    component: Root = "div",
    className,
    ...rootAttrs
  } = props;
  const hasLeading = isFilled(leading);
  const hasCode = isFilled(code);
  const hasMeta = isFilled(meta);
  const hasTrailing = isFilled(trailing);
  return (
    <Root
      {...rootAttrs}
      className={clsx(styles.root, className)}
      data-selected={selected || undefined}
      data-leading={hasLeading || undefined}
    >
      {hasLeading && <div className={styles.leading}>{leading}</div>}
      <div className={styles.body}>
        <div className={styles.main}>
          {hasCode && <span className={styles.code}>{code}</span>}
          <div className={styles.title}>{title}</div>
          {hasMeta && <div className={styles.meta}>{meta}</div>}
        </div>
        {hasTrailing && <div className={styles.trailing}>{trailing}</div>}
      </div>
    </Root>
  );
};
