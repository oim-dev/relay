import clsx from "clsx";
import { useEffect, useEffectEvent, useRef, useState, useId } from "react";
import { Text } from "@mantine/core";
import { isDefined } from "shared/value-predicates";
import type { MarkdownFieldProps } from "./types/markdown-field-props.type";
import type { Compartment, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import styles from "./styles/markdown-field.module.css";

/**
 * Редактирует исходный Markdown с подсветкой синтаксиса.
 *
 * Используется для:
 *  - редактирования описаний и сообщений без копирования состояния формы
 */
export const MarkdownField = (props: MarkdownFieldProps) => {
  const {
    label,
    defaultValue = "",
    onChange,
    onBlur,
    error,
    placeholder,
    disabled,
    required = false,
    withAsterisk = required,
    minRows = 4,
    className,
    "data-path": dataPath,
    ...rootAttrs
  } = props;
  const input = useRef<HTMLDivElement>(null);
  const initialValue = useRef(defaultValue);
  const preservedState = useRef<EditorState | null>(null);
  const [failure, setFailure] = useState(false);
  const labelId = useId();
  const errorId = useId();
  const hasError = isDefined(error) && error !== false && error !== "";
  // Атрибуты доступности и data-path принадлежат редактируемой области (contentDOM), а не
  // обёртке: так form.getInputNode(path)?.focus() переводит фокус в сам редактор.
  const contentAttrs: Record<string, string> = {
    tabindex: "0",
    "aria-labelledby": labelId,
    "aria-multiline": "true",
    ...(required ? { "aria-required": "true" } : {}),
    ...(hasError ? { "aria-invalid": "true", "aria-describedby": errorId } : {}),
    ...(isDefined(dataPath) ? { "data-path": dataPath } : {}),
  };
  const contentAttrsKey = JSON.stringify(contentAttrs);
  const latestAttrs = useRef(contentAttrs);
  latestAttrs.current = contentAttrs;
  const attrsSlot = useRef<{
    view: EditorView;
    compartment: Compartment;
    facet: typeof EditorView.contentAttributes;
  } | null>(null);
  const handleChange = useEffectEvent((value: string) => onChange?.(value));
  const handleBlur = useEffectEvent(() => onBlur?.());
  const handleDisabled = useEffectEvent(() => disabled === true);
  useEffect(() => {
    let disposed = false;
    let destroy: (() => void) | undefined;
    void Promise.all([
      import("@codemirror/view"),
      import("@codemirror/state"),
      import("@codemirror/lang-markdown"),
      import("@codemirror/language"),
      import("@codemirror/commands"),
      import("@lezer/highlight"),
    ])
      .then(([view, state, md, language, commands, highlight]) => {
        if (disposed || input.current === null) return;
        const attributesCompartment = new state.Compartment();
        const extensions = [
          md.markdown(),
          commands.history(),
          view.keymap.of([...commands.defaultKeymap, ...commands.historyKeymap]),
          view.EditorView.lineWrapping,
          // Курсор прокручивается с тем же запасом, что задан прокрутке документа через
          // scroll-padding (например, над липкой панелью действий формы).
          view.EditorView.scrollMargins.of(() => {
            const padding = getComputedStyle(document.documentElement);
            return {
              top: Number.parseFloat(padding.scrollPaddingTop) || 0,
              bottom: Number.parseFloat(padding.scrollPaddingBottom) || 0,
            };
          }),
          attributesCompartment.of(view.EditorView.contentAttributes.of(latestAttrs.current)),
          state.EditorState.changeFilter.of(() => !handleDisabled()),
          view.EditorView.updateListener.of((update) => {
            if (update.docChanged) handleChange(update.state.doc.toString());
          }),
          view.EditorView.domEventHandlers({
            blur: () => {
              handleBlur();
            },
          }),
          view.placeholder(placeholder ?? "Описание в Markdown…"),
          language.syntaxHighlighting(
            language.HighlightStyle.define([
              {
                tag: highlight.tags.heading,
                color: "var(--tasks-accent-ink)",
                fontWeight: "650",
              },
              { tag: highlight.tags.strong, fontWeight: "700" },
              { tag: highlight.tags.emphasis, fontStyle: "italic" },
              {
                tag: [highlight.tags.link, highlight.tags.url],
                color: "var(--tasks-info)",
              },
              {
                tag: [highlight.tags.monospace, highlight.tags.contentSeparator],
                color: "var(--tasks-muted)",
              },
              {
                tag: [highlight.tags.meta, highlight.tags.processingInstruction],
                color: "var(--tasks-soft)",
              },
            ]),
          ),
          view.EditorView.theme({
            "&": {
              backgroundColor: "var(--tasks-surface)",
              color: "var(--tasks-ink)",
              fontSize: "var(--mantine-font-size-sm)",
            },
            ".cm-content": {
              fontFamily: "var(--mantine-font-family-monospace)",
              padding: "var(--mantine-spacing-xs)",
              minHeight: `calc(${minRows * 1.6}em + 2 * var(--mantine-spacing-xs))`,
              caretColor: "var(--tasks-ink)",
              // Строки исходного текста переносятся не шире максимальной меры чтения:
              // поле остаётся на ширину формы, а длинный абзац не растягивается на окно.
              maxWidth: "var(--tasks-reading-measure-max)",
            },
            ".cm-line": { padding: "0", lineHeight: "1.6" },
            ".cm-content .cm-placeholder": { color: "var(--tasks-soft)" },
            ".cm-scroller": { maxHeight: "36dvh", overflow: "auto" },
            "&.cm-focused": { outline: "none" },
          }),
        ];
        const editor = new view.EditorView({
          parent: input.current,
          state: preservedState.current
            ? preservedState.current.update({
                effects: state.StateEffect.reconfigure.of(extensions),
              }).state
            : state.EditorState.create({ doc: initialValue.current, extensions }),
        });
        attrsSlot.current = {
          view: editor,
          compartment: attributesCompartment,
          facet: view.EditorView.contentAttributes,
        };
        // Скрытые табы React отключают эффекты. Состояние редактора переживает их восстановление.
        destroy = () => {
          attrsSlot.current = null;
          preservedState.current = editor.state;
          editor.destroy();
        };
      })
      .catch(() => {
        if (!disposed) setFailure(true);
      });
    return () => {
      disposed = true;
      destroy?.();
    };
  }, [labelId, minRows, placeholder]);
  // Ошибка, обязательность и data-path меняются без пересоздания редактора.
  useEffect(() => {
    const slot = attrsSlot.current;
    if (slot === null) return;
    slot.view.dispatch({
      effects: slot.compartment.reconfigure(slot.facet.of(latestAttrs.current)),
    });
  }, [contentAttrsKey]);
  return (
    <div
      {...rootAttrs}
      className={clsx(styles.root, className)}
      onKeyDownCapture={(event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !disabled) {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.closest("form")?.requestSubmit();
        }
      }}
    >
      <div id={labelId} className={styles.label}>
        {label}
        {withAsterisk && (
          <span className={styles.required} aria-hidden="true">
            {" *"}
          </span>
        )}
      </div>
      <div ref={input} className={styles.editor} aria-disabled={disabled} />
      {failure && (
        <Text c="danger" role="alert">
          Редактор не загрузился. Повторно откройте редактирование; черновик сохранён.
        </Text>
      )}
      <Text id={errorId} size="xs" c="danger">
        {error}
      </Text>
      <span className={styles.hint}>Markdown · Ctrl/⌘ + Enter — сохранить</span>
    </div>
  );
};
