import clsx from "clsx";
import { Text } from "@mantine/core";
import { groupActivityDays } from "../../helpers/activity-presentation";
import { DiscussionMessage } from "../discussion-message/discussion-message";
import type { ActivityFeedProps } from "./types/activity-feed-props.type";
import styles from "./styles/activity-feed.module.css";

/**
 * Организует сообщения обсуждения по дням.
 *
 * Используется для:
 *  - чтения обсуждения без растянутых карточек
 */
export const ActivityFeed = (props: ActivityFeedProps) => {
  const { projectId, taskId, entries, active, className, ...rootAttrs } = props;
  const daysData = groupActivityDays(entries);
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      {daysData.map((day) => (
        <section key={day.key} aria-label={day.label}>
          <Text component="h3" className={styles.day}>
            {day.label}
          </Text>
          <ol className={styles.messages}>
            {day.entries.map((entry) => (
              <li key={entry.id} className={styles.message}>
                <DiscussionMessage
                  projectId={projectId}
                  taskId={taskId}
                  entry={entry}
                  active={active}
                />
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
};
