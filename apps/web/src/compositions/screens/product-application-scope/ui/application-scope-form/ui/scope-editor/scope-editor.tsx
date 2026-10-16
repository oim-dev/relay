import clsx from "clsx";
import { Accordion, Button, Text, TextInput } from "@mantine/core";
import { ArrowLeft, Plus } from "lucide-react";
import { MarkdownField } from "ui/markdown-field";
import { MarkdownView } from "ui/markdown-view";
import { ProductReadiness } from "domains/product-demo";
import { PRODUCT_STATUS_LABELS } from "domains/product";
import type { ScopeEditorProps } from "./types/scope-editor-props.type";
import styles from "./styles/scope-editor.module.css";

/**
 * Сопоставляет общий контракт с описанием вклада конкретного приложения.
 *
 * Используется для:
 *  - последовательного редактирования одного выбранного элемента без потери других текстов
 */
export const ScopeEditor = (props: ScopeEditorProps) => {
  const {
    applicationName,
    title,
    context,
    source,
    isEnabled,
    fieldKey,
    fieldProps,
    titleKey,
    titleProps,
    status,
    onEnable,
    onBack,
    className,
    ...rootAttrs
  } = props;
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <Button
        variant="subtle"
        size="compact-sm"
        leftSection={<ArrowLeft size={14} aria-hidden="true" />}
        className={styles.back}
        onClick={onBack}
      >
        К выбору фич и сценариев
      </Button>
      <header className={styles.header}>
        <Text size="sm" c="dimmed" fw={550}>
          2. Опишите вклад · {context}
        </Text>
        <h2 className={styles.title} tabIndex={-1}>
          {title}
        </h2>
        <Text size="sm" c="dimmed">
          Что приложение «{applicationName}» обеспечивает для выполнения этого контракта.
        </Text>
      </header>
      <Accordion variant="separated" classNames={{ item: styles.source }}>
        <Accordion.Item value="source">
          <Accordion.Control>Исходное описание в продукте</Accordion.Control>
          <Accordion.Panel>
            <MarkdownView text={source} />
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
      <TextInput
        {...titleProps}
        key={titleKey}
        label="Заголовок вклада"
        description="Одна фраза о вашей реализации. Видна под названием фичи или сценария в дереве приложения."
        required
        disabled={!isEnabled}
      />
      <div className={styles.readiness}>
        <Text size="sm" c="dimmed">
          Готовность рассчитывается по задачам реализации.
        </Text>
        <ProductReadiness status={status} label={PRODUCT_STATUS_LABELS[status]} />
      </div>
      {!isEnabled && (
        <div className={styles.notSelected}>
          <Text size="sm" c="dimmed">
            Элемент пока не выбран для этого приложения.
          </Text>
          <Button
            size="xs"
            variant="default"
            onClick={onEnable}
            leftSection={<Plus size={13} aria-hidden="true" />}
          >
            Включить в реализацию
          </Button>
        </div>
      )}
      <MarkdownField
        {...fieldProps}
        key={fieldKey}
        label="Описание вклада в Markdown"
        disabled={!isEnabled}
        minRows={10}
        placeholder="Какие части поведения обеспечивает приложение? Опишите интерфейс, данные, правила, ограничения и ожидаемый результат."
      />
      <Text size="xs" c="dimmed">
        Описание принадлежит этому приложению. Общий контракт фичи или сценария хранится в продукте.
      </Text>
    </div>
  );
};
