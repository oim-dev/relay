import clsx from "clsx";
import { Text } from "@mantine/core";
import { useLocation } from "react-router-dom";
import { useProductDemo } from "domains/product-demo";
import { SectionPanel } from "ui/section-panel";
import { isEmptyArray } from "shared/value-predicates";
import { WorkPlan } from "./ui/work-plan";
import type { ProductWorkListProps } from "./types/product-work-list-props.type";
import styles from "./styles/product-work-list.module.css";

/**
 * Связывает продукт с планами, этапами и краткими результатами задач.
 *
 * Используется для:
 *  - чтения текущей работы и истории реализации без открытия логов
 */
export const ProductWorkList = (props: ProductWorkListProps) => {
  const { featureId, applicationId, className, ...rootAttrs } = props;
  const { snapshot } = useProductDemo();
  const location = useLocation();
  const taskItems = snapshot.work.filter(
    (work) =>
      work.kind === "task" &&
      (featureId === undefined || work.featureIds.includes(featureId)) &&
      (applicationId === undefined || work.applicationIds.includes(applicationId)),
  );
  const stageItems = snapshot.work.filter(
    (work) => work.kind === "stage" && taskItems.some((task) => task.parentId === work.id),
  );
  const planItems = snapshot.work
    .filter(
      (work) => work.kind === "plan" && stageItems.some((stage) => stage.parentId === work.id),
    )
    .sort((first, second) => Number(first.status === "done") - Number(second.status === "done"));
  const hasNoWork = isEmptyArray(taskItems);
  const returnTo = location.pathname + location.search;
  return (
    <SectionPanel
      {...rootAttrs}
      className={clsx(styles.root, className)}
      title="Связанная работа"
      description="Что меняется сейчас и в каких планах появился результат."
    >
      {hasNoWork && (
        <div className={styles.empty}>
          <Text size="sm" fw={550}>
            Работа ещё не запланирована
          </Text>
          <Text size="sm" c="dimmed">
            Планы, этапы и задачи появятся, когда работа над этой частью продукта войдёт в очередной
            цикл.
          </Text>
        </div>
      )}
      <div className={styles.plans}>
        {planItems.map((plan) => (
          <WorkPlan
            key={plan.id}
            plan={plan}
            stages={stageItems}
            tasks={taskItems}
            returnTo={returnTo}
          />
        ))}
      </div>
    </SectionPanel>
  );
};
