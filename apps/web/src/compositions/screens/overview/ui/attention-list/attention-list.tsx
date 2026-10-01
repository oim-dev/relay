import clsx from "clsx";
import { OVERVIEW_SECTION_IDS } from "../../config/overview.config";
import { MetricDisclosure } from "../metric-disclosure/metric-disclosure";
import { AttentionGroup } from "./ui/attention-group/attention-group";
import { ReviewObligations } from "./ui/review-obligations/review-obligations";
import type { AttentionListProps } from "./types/attention-list-props.type";
import styles from "./styles/attention-list.module.css";

/**
 * Показывает задачи в работе, на проверке и заблокированные с причинами блокировки.
 * Полный набор каждой группы читается по проекту тем же фильтром, что и подборка обзора.
 * Проверку дополняет разделение по готовности обязательств, блокировки — прямые блокеры
 * с числом задач, которые каждый из них задерживает.
 *
 * Используется для:
 *  - ответа на вопрос «что сейчас происходит и что мешает»
 *  - перехода к конкретной задаче на её доске
 */
export const AttentionList = (props: AttentionListProps) => {
  const { attention, operator, snapshotVersion, basePath, className, ...rootAttrs } = props;
  const { blockerImpact } = operator;
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <AttentionGroup
        id={OVERVIEW_SECTION_IDS.attentionInProgress}
        title="В работе"
        emptyText="Сейчас нет задач в работе."
        preview={attention.inProgress}
        filters={{ column: "in-progress" }}
        basePath={basePath}
      />
      <AttentionGroup
        id={OVERVIEW_SECTION_IDS.attentionReview}
        title="На проверке"
        emptyText="Нет задач, ожидающих проверки."
        preview={attention.review}
        filters={{ column: "review" }}
        basePath={basePath}
      />
      <ReviewObligations
        review={operator.review}
        snapshotVersion={snapshotVersion}
        basePath={basePath}
      />
      <MetricDisclosure
        id={OVERVIEW_SECTION_IDS.blockerImpact}
        title="Что задерживает работу"
        hint="Задачи, которые напрямую не дают завершить другую незавершённую работу: как зависимость или незавершённая подзадача. Это прямое влияние, не критический путь и не приоритет."
        request={{ metric: "blocker-impact" }}
        preview={{
          total: blockerImpact.total,
          hasMore: blockerImpact.hasMore,
          entries: blockerImpact.items.map((blocker) => ({
            kind: "blocker",
            id: blocker.id,
            blocker,
          })),
        }}
        isPreviewShown
        tone="attention"
        emptyText="Ни одна задача сейчас не задерживает другую незавершённую работу."
        snapshotVersion={snapshotVersion}
        basePath={basePath}
      />
      <AttentionGroup
        id={OVERVIEW_SECTION_IDS.attentionBlocked}
        title="Заблокированы"
        emptyText="Заблокированных задач нет."
        preview={attention.blocked}
        filters={{ readiness: "blocked" }}
        shouldShowColumn
        tone="blocked"
        basePath={basePath}
      />
    </div>
  );
};
