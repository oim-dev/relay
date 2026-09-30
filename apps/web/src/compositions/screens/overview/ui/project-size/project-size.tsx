import { useId } from "react";
import clsx from "clsx";
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
 * Показывает полный объём проекта: задачи, доски, документы и продуктовые знания.
 * Задачи и доски не имеют общего раздела проекта, поэтому ведут к блокам этого экрана.
 *
 * Используется для:
 *  - оценки размера проекта без конкуренции со срочной работой
 *  - перехода к полному распределению задач, каталогу досок и разделам проекта
 */
export const ProjectSize = (props: ProjectSizeProps) => {
  const { tasks, boards, documents, knowledge, basePath, className, ...rootAttrs } = props;
  const titleId = useId();
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
  return (
    <section {...rootAttrs} className={clsx(styles.root, className)} aria-labelledby={titleId}>
      <h2 id={titleId} className={styles.title}>
        Размер проекта
      </h2>
      <ul className={styles.list} aria-label="Размер проекта">
        {sizeItems.map((item) => {
          const content = (
            <>
              <span className={styles.label}>{item.label}</span>
              <span className={styles.value}>{item.value}</span>
              {isDefined(item.detail) && <span className={styles.detail}>{item.detail}</span>}
            </>
          );
          return (
            <li key={item.label} className={styles.item}>
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
    </section>
  );
};
