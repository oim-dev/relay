import { useId, useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Button } from "@mantine/core";
import { ChevronDown, ChevronUp } from "lucide-react";
import { isDefined } from "shared/value-predicates";
import type { PassportSummaryProps } from "./types/passport-summary-props.type";
import styles from "./styles/passport-summary.module.css";

/**
 * Показывает краткое описание продукта, ограниченное по высоте, с явным раскрытием.
 * Кнопка появляется только когда текст действительно не помещается в свёрнутую высоту.
 *
 * Используется для:
 *  - короткого паспорта в заголовке обзора без вытеснения операционных показателей
 */
export const PassportSummary = (props: PassportSummaryProps) => {
  const { text, className, ...rootAttrs } = props;
  const textId = useId();
  const textRef = useRef<HTMLParagraphElement>(null);
  const [isExpanded, setExpanded] = useState(false);
  const [isClamped, setClamped] = useState(false);
  // Свёрнутая высота зависит от ширины и масштаба, поэтому переполнение измеряется наблюдателем.
  useLayoutEffect(() => {
    const element = textRef.current;
    if (!isDefined(element) || isExpanded) return;
    const measure = (): void => setClamped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, isExpanded]);
  const canToggle = isClamped || isExpanded;
  const toggleLabel = isExpanded ? "Свернуть описание" : "Показать описание полностью";
  const ToggleIcon = isExpanded ? ChevronUp : ChevronDown;
  const expandedMark = isExpanded ? "" : undefined;
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <p id={textId} ref={textRef} className={styles.text} data-expanded={expandedMark}>
        {text}
      </p>
      {canToggle && (
        <Button
          size="compact-sm"
          variant="subtle"
          className={styles.toggle}
          aria-expanded={isExpanded}
          aria-controls={textId}
          leftSection={<ToggleIcon size={14} aria-hidden="true" />}
          onClick={() => setExpanded(!isExpanded)}
        >
          {toggleLabel}
        </Button>
      )}
    </div>
  );
};
