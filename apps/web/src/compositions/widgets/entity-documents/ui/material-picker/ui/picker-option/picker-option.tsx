import clsx from "clsx";
import { ActionIcon, Checkbox, Tooltip } from "@mantine/core";
import { Eye } from "lucide-react";
import { DOCUMENT_KINDS, DOCUMENT_STATUSES, MATERIAL_FORMATS } from "domains/documents";
import { isNonEmptyArray } from "shared/value-predicates";
import type { PickerOptionProps } from "./types/picker-option-props.type";
import styles from "./styles/picker-option.module.css";

/**
 * Показывает один материал библиотеки как выбираемый вариант: назначение, свойства
 * и уже существующие связи с сущностью.
 *
 * Используется для:
 *  - множественного выбора материалов для прикрепления
 */
export const PickerOption = (props: PickerOptionProps) => {
  const {
    material,
    sectionName,
    attachedLabels,
    isSelected,
    isLocked,
    isDisabled,
    onToggle,
    onPreview,
    previewRef,
    className,
    ...rootAttrs
  } = props;
  const data = material.document;
  const metaItems = [
    data ? DOCUMENT_KINDS[data.kind] : "Материал",
    data ? MATERIAL_FORMATS[data.format] : "",
    data && data.status !== "active" ? DOCUMENT_STATUSES[data.status] : "",
    sectionName,
  ].filter((item) => item !== "");
  const hasSummary = material.summary.trim() !== "";
  const attachedText = `Уже прикреплён: ${attachedLabels.join(", ").toLowerCase()}`;
  return (
    <div
      {...rootAttrs}
      className={clsx(styles.root, className)}
      data-selected={isSelected}
      data-locked={isLocked}
    >
      <Checkbox
        className={styles.checkbox}
        classNames={{ body: styles.checkboxBody, labelWrapper: styles.checkboxLabel }}
        checked={isSelected || isLocked}
        disabled={isLocked || isDisabled}
        aria-describedby={`${material.ref.id}-meta`}
        label={<span className={styles.title}>{material.title}</span>}
        onChange={(event) => onToggle(event.currentTarget.checked)}
      />
      <Tooltip label="Предпросмотр">
        <ActionIcon
          ref={previewRef}
          variant="subtle"
          color="gray"
          aria-label={`Предпросмотр: ${material.title}`}
          onClick={onPreview}
        >
          <Eye size={16} aria-hidden="true" />
        </ActionIcon>
      </Tooltip>
      <div id={`${material.ref.id}-meta`} className={styles.details}>
        <p className={styles.meta}>{metaItems.join(" · ")}</p>
        {hasSummary && <p className={styles.summary}>{material.summary}</p>}
        {isNonEmptyArray(attachedLabels) && <p className={styles.attached}>{attachedText}</p>}
      </div>
    </div>
  );
};
