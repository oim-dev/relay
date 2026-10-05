import { useState } from "react";
import { Button } from "@mantine/core";
import { MaterialTagsInput } from "domains/documents";
import { isEmptyArray } from "shared/value-predicates";
import type { BulkTagsFormProps } from "./types/bulk-tags-form-props.type";
import styles from "./styles/bulk-tags-form.module.css";

/** Подписи режимов. */
const MODE_TEXT = {
  addTags: {
    label: "Добавить теги",
    hint: "Новый тег создаётся вводом и Enter",
    action: "Добавить выбранным",
  },
  removeTags: {
    label: "Снять теги",
    hint: "Теги выбранных материалов",
    action: "Снять у выбранных",
  },
};

/**
 * Собирает набор тегов для одного массового действия и применяет его явной кнопкой.
 * Кнопка стоит над полем, чтобы список подсказок её не закрывал.
 *
 * Используется для:
 *  - добавления и снятия тегов у выбранных материалов в панели и на телефоне
 */
export const BulkTagsForm = (props: BulkTagsFormProps) => {
  const { mode, projectId, selectedTags, onApply } = props;
  const [tags, setTags] = useState<string[]>([]);
  const text = MODE_TEXT[mode];
  const suggestions = mode === "removeTags" ? selectedTags : undefined;
  return (
    <div className={styles.root}>
      <Button size="xs" disabled={isEmptyArray(tags)} onClick={() => onApply(tags)}>
        {text.action}
      </Button>
      <MaterialTagsInput
        projectId={projectId}
        label={text.label}
        description={text.hint}
        value={tags}
        suggestions={suggestions}
        onChange={setTags}
      />
    </div>
  );
};
