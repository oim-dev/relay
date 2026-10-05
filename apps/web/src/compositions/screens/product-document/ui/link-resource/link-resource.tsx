import clsx from "clsx";
import { useState } from "react";
import { Button, Text } from "@mantine/core";
import { Check, Copy, ExternalLink, Globe } from "lucide-react";
import { MarkdownView } from "ui/markdown-view";
import type { LinkResourceProps } from "./types/link-resource-props.type";
import styles from "./styles/link-resource.module.css";

/** Разбирает адрес, допуская для перехода только http и https. */
const readWebUrl = (value: string): URL | null => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

/**
 * Показывает материал-ссылку собственной карточкой: куда ведёт ссылка, зачем её открывать
 * и явное действие перехода в новой вкладке. Автоматического перехода нет.
 *
 * Используется для:
 *  - чтения внешнего материала из карточки библиотеки
 */
export const LinkResource = (props: LinkResourceProps) => {
  const { url, explanation, className, ...rootAttrs } = props;
  const [isCopied, setCopied] = useState(false);
  const webUrl = readWebUrl(url);
  const host = webUrl?.hostname.replace(/^www\./, "") ?? "Адрес недоступен для перехода";
  const hasExplanation = explanation.trim() !== "";
  const CopyIcon = isCopied ? Check : Copy;
  const copyLabel = isCopied ? "Адрес скопирован" : "Скопировать адрес";
  /** Копирует адрес, сообщая результат на кнопке. */
  const handleCopy = (): void => {
    void navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  };
  return (
    <section
      {...rootAttrs}
      className={clsx(styles.root, className)}
      aria-labelledby="link-resource-title"
    >
      <div className={styles.resource}>
        <span className={styles.icon} aria-hidden="true">
          <Globe size={22} />
        </span>
        <div className={styles.address}>
          <h2 id="link-resource-title" className={styles.host}>
            {host}
          </h2>
          <p className={styles.url}>{url}</p>
        </div>
      </div>
      <div className={styles.actions}>
        {webUrl !== null && (
          <Button
            component="a"
            href={webUrl.href}
            target="_blank"
            rel="noopener noreferrer"
            radius="xl"
            size="md"
            rightSection={<ExternalLink size={16} aria-hidden="true" />}
          >
            Открыть ресурс
            <span className={styles.hidden}> (в новой вкладке)</span>
          </Button>
        )}
        <Button
          variant="default"
          radius="xl"
          size="md"
          leftSection={<CopyIcon size={15} aria-hidden="true" />}
          onClick={handleCopy}
        >
          {copyLabel}
        </Button>
      </div>
      <div className={styles.explanation}>
        <h3 className={styles.explanationTitle}>Пояснение</h3>
        {hasExplanation && <MarkdownView text={explanation} />}
        {!hasExplanation && (
          <Text size="sm" c="dimmed">
            Пояснение не добавлено. Назначение ссылки описано в шапке материала.
          </Text>
        )}
      </div>
    </section>
  );
};
