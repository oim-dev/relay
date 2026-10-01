import clsx from "clsx";
import { Progress } from "@mantine/core";
import { Link } from "react-router-dom";
import { isDefined } from "shared/value-predicates";
import { OVERVIEW_SECTION_IDS } from "../../config/overview.config";
import { countLabel } from "../../helpers/count-label";
import type { ProjectSizeProps } from "./types/project-size-props.type";
import styles from "./styles/project-size.module.css";

/** Показатель размера: внутренний якорь, раздел проекта или только число. */
type SizeItem = {
  label: string;
  value: number;
  detail: string | null;
  anchor?: string;
  path?: string;
};

/**
 * Показывает полный объём проекта горизонтальной столбиковой диаграммой: задачи, доски,
 * документы и продуктовые знания. У каждой полосы подпись, точное число и расшифровка;
 * полосы скрыты от скринридера. Задачи и доски не имеют общего раздела проекта,
 * поэтому ведут к блокам этого экрана.
 *
 * Используется для:
 *  - оценки размера проекта без конкуренции со срочной работой
 *  - перехода к полному распределению задач, каталогу досок и разделам проекта
 */
export const ProjectSize = (props: ProjectSizeProps) => {
  const { tasks, boards, documents, knowledge, basePath, className, ...rootAttrs } = props;
  const sizeItems: SizeItem[] = [
    {
      label: "Задачи",
      value: tasks.total,
      detail: null,
      anchor: OVERVIEW_SECTION_IDS.tasks,
    },
    {
      label: "Доски",
      value: boards.total,
      detail: [
        countLabel("продукт", boards.byKind.product),
        countLabel("приложения", boards.byKind.application),
        countLabel("инфраструктура", boards.byKind.infrastructure),
      ].join(", "),
      anchor: OVERVIEW_SECTION_IDS.boards,
    },
    {
      label: "Документы",
      value: documents.total,
      detail: [
        countLabel("действующих", documents.byStatus.active),
        countLabel("черновиков", documents.byStatus.draft),
        countLabel("в архиве", documents.byStatus.archived),
      ].join(", "),
      path: `${basePath}/documents`,
    },
    {
      label: "Фичи",
      value: knowledge.features.total,
      detail: null,
      path: `${basePath}/product/features`,
    },
    { label: "Сценарии", value: knowledge.scenarios.total, detail: null },
    {
      label: "Приложения",
      value: knowledge.applications.total,
      detail: null,
      path: `${basePath}/product/applications`,
    },
  ];
  const largestValue = Math.max(...sizeItems.map((item) => item.value));
  const barItems = sizeItems.map((item) => {
    // Длина полосы — геометрия диаграммы; точное число подписано текстом.
    const share = largestValue === 0 ? 0 : (item.value / largestValue) * 100;
    return { ...item, share, emptyMark: item.value === 0 ? "" : undefined };
  });
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <ul className={styles.list} aria-label="Размер проекта">
        {barItems.map((item) => {
          const content = (
            <>
              <span className={styles.label}>{item.label}</span>
              <span className={styles.value}>{item.value}</span>
              <Progress
                variant="accent"
                value={item.share}
                className={styles.bar}
                aria-hidden="true"
              />
              {isDefined(item.detail) && <span className={styles.detail}>{item.detail}</span>}
            </>
          );
          return (
            <li key={item.label} className={styles.item} data-empty={item.emptyMark}>
              {isDefined(item.anchor) && (
                <a href={`#${item.anchor}`} className={styles.cell}>
                  {content}
                </a>
              )}
              {isDefined(item.path) && (
                <Link to={item.path} className={styles.cell}>
                  {content}
                </Link>
              )}
              {!isDefined(item.anchor) && !isDefined(item.path) && (
                <div className={styles.cell}>{content}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
