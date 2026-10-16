import clsx from "clsx";
import { ActionIcon } from "@mantine/core";
import { ArrowUpRight, Route } from "lucide-react";
import { Link } from "react-router-dom";
import { ProductReadiness } from "domains/product-demo";
import { ProductKey } from "domains/product";
import type { ScenarioSectionProps } from "./types/scenario-section-props.type";
import styles from "./styles/scenario-section.module.css";

/**
 * Показывает компактную строку сценария с отдельной готовностью и переходом.
 *
 * Используется для:
 *  - выбора сценария для чтения полного описания и реализующих задач
 */
export const ScenarioSection = (props: ScenarioSectionProps) => {
  const { scenario, featurePath, search, className, ...rootAttrs } = props;
  const anchor = `scenario-${scenario.id}`;
  const headingId = `${anchor}-heading`;
  const href = `${featurePath}/scenarios/${scenario.key ?? scenario.id}${search}`;
  const returnTo = `${featurePath}${search}#scenarios`;
  return (
    <section
      {...rootAttrs}
      id={anchor}
      aria-labelledby={headingId}
      tabIndex={-1}
      className={clsx(styles.root, className)}
    >
      <header className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          <Route size={18} />
        </span>
        <div className={styles.meaning}>
          <ProductKey value={scenario.key} />
          <h3 id={headingId} className={styles.title}>
            <Link to={href} state={{ returnTo }} className={styles.link}>
              {scenario.name}
            </Link>
          </h3>
          <ProductReadiness status={scenario.status} />
        </div>
        <ActionIcon
          component={Link}
          to={href}
          state={{ returnTo }}
          variant="subtle"
          aria-label={`Открыть описание и задачи: ${scenario.name}`}
          title="Открыть описание и задачи"
        >
          <ArrowUpRight size={16} aria-hidden="true" />
        </ActionIcon>
      </header>
    </section>
  );
};
