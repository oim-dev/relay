import clsx from "clsx";
import { Popover, Text, UnstyledButton } from "@mantine/core";
import { LoaderCircle, RefreshCw, TriangleAlert, WifiOff } from "lucide-react";
import { isDefined } from "shared/value-predicates";
import type { ConnectionState, ConnectionStatusProps } from "./types/connection-status-props.type";
import styles from "./styles/connection-status.module.css";

/** Подпись, пояснение и значок каждого состояния; смысл не передаётся одним цветом. */
const STATES: Record<
  ConnectionState,
  { label: string; explanation: string; Icon: typeof RefreshCw | null }
> = {
  connected: {
    label: "Синхронизировано",
    explanation: "Изменения других участников и агентов появляются на экране автоматически.",
    Icon: null,
  },
  connecting: {
    label: "Соединяемся",
    explanation: "Подключаемся к потоку изменений проекта. Данные на экране уже можно читать.",
    Icon: LoaderCircle,
  },
  reconnecting: {
    label: "Переподключаемся",
    explanation:
      "Связь с сервером прервалась. Показаны последние полученные данные; чужие изменения появятся после восстановления.",
    Icon: RefreshCw,
  },
  disconnected: {
    label: "Нет соединения",
    explanation:
      "Сервер Relay недоступен. Показаны последние полученные данные. Проверьте, что relay-server запущен.",
    Icon: WifiOff,
  },
  "storage-error": {
    label: "Ошибка хранилища",
    explanation:
      "Сервер не может прочитать документы проекта. Показаны последние полученные данные.",
    Icon: TriangleAlert,
  },
};

/**
 * Показывает состояние синхронизации проекта и объясняет его по нажатию.
 * Подпись видна на широком экране, а на узком остаётся доступным именем кнопки;
 * смена состояния объявляется вежливой живой областью.
 *
 * Используется для:
 *  - сигнала устаревания данных в шапке проекта
 *  - пояснения отказа соединения или хранилища с клавиатуры и на touch
 */
export const ConnectionStatus = (props: ConnectionStatusProps) => {
  const { state, message, className, ...rootAttrs } = props;
  const { label, explanation, Icon } = STATES[state];
  const isProblem = state !== "connected" && state !== "connecting";
  const hasMessage = isDefined(message) && message !== "";
  const indicator = isDefined(Icon) ? (
    <Icon size={16} className={styles.icon} aria-hidden="true" />
  ) : (
    <span className={styles.dot} aria-hidden="true" />
  );
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)} role="status">
      <Popover position="bottom-end" width={288} withArrow shadow="md" trapFocus returnFocus>
        <Popover.Target>
          <UnstyledButton className={styles.trigger} data-state={state} data-problem={isProblem}>
            {indicator}
            <span className={styles.label}>
              <span className={styles.hidden}>Подключение: </span>
              {label}
            </span>
          </UnstyledButton>
        </Popover.Target>
        <Popover.Dropdown className={styles.dropdown}>
          <Text size="sm" fw={650}>
            {label}
          </Text>
          <Text size="sm" c="dimmed">
            {explanation}
          </Text>
          {hasMessage && (
            <Text size="sm" className={styles.message}>
              {message}
            </Text>
          )}
        </Popover.Dropdown>
      </Popover>
    </div>
  );
};
