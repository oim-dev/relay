import clsx from "clsx";
import { OVERVIEW_SECTION_IDS } from "../../config/overview.config";
import { AttentionGroup } from "./ui/attention-group/attention-group";
import type { AttentionListProps } from "./types/attention-list-props.type";
import styles from "./styles/attention-list.module.css";

/**
 * Показывает задачи в работе, на проверке и заблокированные с причинами блокировки.
 * Полный набор каждой группы читается по проекту тем же фильтром, что и подборка обзора.
 *
 * Используется для:
 *  - ответа на вопрос «что сейчас происходит и что мешает»
 *  - перехода к конкретной задаче на её доске
 */
export const AttentionList = (props: AttentionListProps) => {
  const { attention, basePath, className, ...rootAttrs } = props;
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
