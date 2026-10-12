import type { CSSProperties } from "react";
import clsx from "clsx";
import { SectionPanel } from "ui/section-panel";
import { KitExample } from "../kit-example/kit-example";
import { KIT_COLOR_GROUPS, KIT_DATA_ROLES } from "./config/kit-colors.config";
import styles from "./styles/kit-colors.module.css";

/** Локальные переменные образца: ссылки на роли темы. */
const swatchStyle = (background: string, text: string) =>
  ({
    "--swatch-bg": `var(--tasks-${background})`,
    "--swatch-ink": `var(--tasks-${text})`,
  }) as CSSProperties;

/** Строка применения первой пары группы: фактические роли фона и текста. */
const getPairUsage = (pair: { background: string; text: string } | undefined): string =>
  pair === undefined
    ? ""
    : `background-color: var(--tasks-${pair.background}); color: var(--tasks-${pair.text});`;

/**
 * Показывает цветовые роли темы парами «текст на фоне» и роли данных.
 *
 * Используется для:
 *  - выбора роли вместо оттенка палитры и проверки читаемости в обеих схемах
 */
export const KitColors = () => {
  return (
    <SectionPanel
      title="Цветовые роли"
      description="Значения вычисляет ui/themes для каждой схемы."
    >
      {KIT_COLOR_GROUPS.map((group) => (
        <KitExample
          key={group.title}
          title={group.title}
          purpose="Пара фона и текста, проверенная на контраст по разделу 5.1."
          importLine={getPairUsage(group.pairs[0])}
          rule="Компонент берёт роль по смыслу, не оттенок палитры и не hex."
        >
          <ul className={styles.grid}>
            {group.pairs.map((pair) => (
              <li
                key={`${pair.background}-${pair.text}`}
                className={styles.swatch}
                style={swatchStyle(pair.background, pair.text)}
              >
                <span className={styles.sample}>Аа 123</span>
                <span className={styles.usage}>{pair.usage}</span>
                <code className={styles.roles}>
                  {pair.text} / {pair.background}
                </code>
              </li>
            ))}
          </ul>
        </KitExample>
      ))}
      <KitExample
        title="Роли данных"
        purpose="Колонки задач, выполнение, блокировка и прогресс на диаграммах."
        importLine="--stage-color: var(--tasks-column-done);"
        rule="Цвет колонки дополняется подписью и иконкой; цвет не единственный признак."
      >
        <ul className={styles.grid}>
          {KIT_DATA_ROLES.map((item) => (
            <li key={item.role} className={styles.dataSwatch} style={swatchStyle(item.role, "ink")}>
              <span className={styles.marker} aria-hidden="true" />
              {item.label}
              <code className={clsx(styles.roles, styles.dataRole)}>{item.role}</code>
            </li>
          ))}
        </ul>
      </KitExample>
    </SectionPanel>
  );
};
