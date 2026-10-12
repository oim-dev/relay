import clsx from "clsx";
import { ActionIcon, Tooltip } from "@mantine/core";
import { useClipboard } from "@mantine/hooks";
import { Check, Copy } from "lucide-react";
import type { ProductKeyProps } from "./types/product-key-props.type";
import styles from "./styles/product-key.module.css";

/**
 * Показывает читаемый адрес продукта рядом с названием и явно копирует его.
 *
 * Используется для:
 *  - единообразного отображения ключей в заголовках, списках и связях
 */
export const ProductKey = (props: ProductKeyProps) => {
  const { value, copyable = false, className, ...rootAttrs } = props;
  const clipboard = useClipboard({ timeout: 1600 });
  const Icon = clipboard.copied ? Check : Copy;
  const label = clipboard.error
    ? "Не удалось скопировать"
    : clipboard.copied
      ? "Ключ скопирован"
      : `Скопировать ${value}`;
  const announcement = clipboard.copied ? "Ключ скопирован" : "";
  if (value === undefined) return null;
  return (
    <span {...rootAttrs} className={clsx(styles.root, className)}>
      <span>{value}</span>
      {copyable && (
        <Tooltip label={label} withArrow>
          <ActionIcon
            size="xs"
            variant="subtle"
            aria-label={label}
            onClick={() => clipboard.copy(value)}
          >
            <Icon size={13} aria-hidden="true" />
          </ActionIcon>
        </Tooltip>
      )}
      <span className={styles.announcement} role="status">
        {announcement}
      </span>
    </span>
  );
};
