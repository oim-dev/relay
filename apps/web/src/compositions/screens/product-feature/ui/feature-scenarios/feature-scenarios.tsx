import clsx from "clsx";
import { useState } from "react";
import { Button, Text, VisuallyHidden } from "@mantine/core";
import { Plus } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useProductPath } from "compositions/widgets/product-page";
import { SectionPanel } from "ui/section-panel";
import { isEmptyArray } from "shared/value-predicates";
import { ScenarioSection } from "./ui/scenario-section/scenario-section";
import type { FeatureScenariosProps } from "./types/feature-scenarios-props.type";
import styles from "./styles/feature-scenarios.module.css";

/**
 * Представляет постоянные подразделы фичи и точку добавления нового сценария.
 *
 * Используется для:
 *  - чтения ожидаемого поведения и перехода к редактору сценария
 */
export const FeatureScenarios = (props: FeatureScenariosProps) => {
  const { feature, className, ...rootAttrs } = props;
  const base = useProductPath();
  const location = useLocation();
  const [count, setCount] = useState(10);
  const orderedScenarios = [...feature.scenarios].sort((left, right) =>
    (left.key ?? left.name).localeCompare(right.key ?? right.name, "ru", { numeric: true }),
  );
  const anchorIndex = orderedScenarios.findIndex(
    (entry) => location.hash === `#scenario-${entry.id}`,
  );
  const visibleCount = Math.max(count, anchorIndex + 1);
  const scenarioItems = orderedScenarios.slice(0, visibleCount);
  const hasMore = visibleCount < feature.scenarios.length;
  const featurePath = `${base}/features/${feature.key ?? feature.id}`;
  const hasNoScenarios = isEmptyArray(feature.scenarios);
  const readyCount = feature.scenarios.filter((scenario) => scenario.status === "done").length;
  return (
    <SectionPanel
      {...rootAttrs}
      id="scenarios"
      tabIndex={-1}
      className={clsx(styles.root, className)}
      title="Сценарии фичи"
      count={
        <>
          <VisuallyHidden>Сценариев: </VisuallyHidden>
          {feature.scenarios.length}
        </>
      }
      description={`Реализовано ${readyCount} из ${feature.scenarios.length} · у каждого сценария свои задачи`}
      actions={
        <Button
          component={Link}
          to={`${featurePath}/scenarios/new${location.search}`}
          variant="default"
          leftSection={<Plus size={15} aria-hidden="true" />}
        >
          Добавить сценарий
        </Button>
      }
    >
      {hasNoScenarios && (
        <div className={styles.empty}>
          <Text fw={600}>Сценарии не описаны</Text>
          <Text size="sm" c="dimmed">
            Опишите первое конкретное поведение. У сценария будет собственная страница и список
            задач.
          </Text>
        </div>
      )}
      {!hasNoScenarios && (
        <div className={styles.sections}>
          {scenarioItems.map((scenario) => (
            <ScenarioSection
              key={scenario.id}
              scenario={scenario}
              featurePath={featurePath}
              search={location.search}
            />
          ))}
        </div>
      )}
      {hasMore && (
        <Button
          variant="subtle"
          className={styles.more}
          onClick={() => setCount(visibleCount + 10)}
        >
          Ещё сценарии · показано {scenarioItems.length} из {feature.scenarios.length}
        </Button>
      )}
    </SectionPanel>
  );
};
