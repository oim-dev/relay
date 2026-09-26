import clsx from "clsx";
import { useRef, useState } from "react";
import { useHotkeys } from "@mantine/hooks";
import { MessageSquarePlus } from "lucide-react";
import { useForm } from "@mantine/form";
import { Alert, Button, Checkbox, Group, Stack, Text, TextInput } from "@mantine/core";
import { z } from "zod";
import { publishTaskComment, BoardTaskError } from "domains/board-tasks";
import { readSessionStored, writeSessionStored, removeSessionStored } from "infra/browser-storage";
import { MarkdownField } from "ui/markdown-field";
import type { CommentFormProps } from "./types/comment-form-props.type";
import styles from "./styles/comment-form.module.css";

/**
 * Публикует сообщение оператора с устойчивым черновиком без автоматического повтора.
 *
 * Используется для:
 *  - ввода заголовка и полного Markdown без потери при ошибке или закрытии
 */
export const CommentForm = (props: CommentFormProps) => {
  const { projectId, taskId, onPublished, className, ...rootAttrs } = props;
  const draftKey = `relay:comment:${projectId}:${taskId}`;
  const [draft] = useState(() => COMMENT_DRAFT_SCHEMA.safeParse(readSessionStored(draftKey)));
  const [isOpen, setOpen] = useState(draft.success);
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [defect, setDefect] = useState<unknown>();
  const [canPersist, setCanPersist] = useState(true);
  const requestRef = useRef(draft.success ? draft.data.requestId : undefined);
  const [hasUnknownOutcome, setUnknownOutcome] = useState(
    draft.success && draft.data.requestId !== undefined,
  );
  const [hasCheckedDiscussion, setCheckedDiscussion] = useState(false);
  const form = useForm({
    mode: "uncontrolled",
    initialValues: draft.success ? draft.data.values : { title: "", description: "" },
    validate: {
      title: (value) =>
        value.trim() === ""
          ? "Введите заголовок"
          : /[\r\n]/.test(value)
            ? "Заголовок должен быть однострочным"
            : new TextEncoder().encode(value).length > 1024
              ? "Заголовок превышает 1024 байта"
              : null,
      description: (value) =>
        value.trim() === ""
          ? "Введите сообщение"
          : new TextEncoder().encode(value).length > 256 * 1024
            ? "Сообщение превышает 256 КиБ"
            : null,
    },
    onValuesChange: (values) => {
      setCanPersist(writeSessionStored(draftKey, { values, requestId: requestRef.current }));
      setNotice("");
    },
  });
  const hasError = error !== "";
  const hasNotice = notice !== "";
  const canPublish = !hasUnknownOutcome || hasCheckedDiscussion;
  useHotkeys(
    [
      [
        "mod+Enter",
        () => {
          if (isOpen && !form.submitting && formRef.current?.contains(document.activeElement))
            formRef.current.requestSubmit();
        },
      ],
    ],
    [],
  );
  /**
   * Новая отправка требует проверки обсуждения при неизвестном исходе предыдущей.
   */
  const handleSubmit = async (values: typeof form.values): Promise<void> => {
    if (!canPublish || form.submitting) return;
    setError("");
    requestRef.current = crypto.randomUUID();
    setCheckedDiscussion(false);
    setCanPersist(writeSessionStored(draftKey, { values, requestId: requestRef.current }));
    try {
      await publishTaskComment(projectId, taskId, { ...values, requestId: requestRef.current });
    } catch (failure) {
      setUnknownOutcome(true);
      if (failure instanceof BoardTaskError) setError(failure.message);
      else setDefect(failure);
      return;
    }
    form.setValues({ title: "", description: "" });
    form.resetDirty();
    removeSessionStored(draftKey);
    requestRef.current = undefined;
    setUnknownOutcome(false);
    setNotice("Сообщение опубликовано");
    setOpen(false);
    await onPublished();
  };
  if (defect !== undefined) throw defect;
  if (!isOpen)
    return (
      <Group justify="space-between" className={styles.collapsed}>
        <Button
          variant="light"
          leftSection={<MessageSquarePlus size={16} />}
          onClick={() => {
            setNotice("");
            setError("");
            setOpen(true);
            requestAnimationFrame(() => formRef.current?.querySelector("input")?.focus());
          }}
        >
          Написать сообщение
        </Button>
        {hasNotice && (
          <Text role="status" size="sm" c="teal">
            {notice}
          </Text>
        )}
      </Group>
    );
  return (
    <form
      {...rootAttrs}
      ref={formRef}
      className={clsx(styles.root, className)}
      onSubmit={form.onSubmit(handleSubmit)}
    >
      <Stack gap="sm">
        <Group justify="space-between">
          <Text fw={600} size="sm">
            Новое сообщение
          </Text>
          <Text size="xs" c="dimmed">
            Оператор
          </Text>
        </Group>
        <TextInput
          label="Заголовок сообщения"
          placeholder="О чём это сообщение"
          required
          disabled={form.submitting}
          key={form.key("title")}
          {...form.getInputProps("title")}
        />
        <MarkdownField
          label="Текст сообщения"
          placeholder="Вопрос, решение или результат работы…"
          minRows={6}
          disabled={form.submitting}
          key={form.key("description")}
          {...form.getInputProps("description")}
        />
        {!canPersist && (
          <Alert color="yellow">
            Локальное хранилище недоступно. Не закрывайте карточку до публикации.
          </Alert>
        )}
        {hasError && (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
        {hasUnknownOutcome && (
          <Alert color="yellow" title="Проверьте обсуждение перед новой публикацией" role="alert">
            Предыдущая отправка могла создать сообщение. Обновите ленту и проверьте новые записи,
            включая следующие страницы. Черновик сохранён. Повторная отправка может создать
            дубликат: сервер не устраняет повторные публикации автоматически.
            <Checkbox
              mt="sm"
              label="Я перечитал обсуждение и хочу отправить сообщение заново"
              checked={hasCheckedDiscussion}
              onChange={(event) => setCheckedDiscussion(event.currentTarget.checked)}
              disabled={form.submitting}
            />
          </Alert>
        )}
        {hasNotice && (
          <Text role="status" c="green">
            {notice}
          </Text>
        )}
        <Group justify="flex-end">
          <Group gap="xs">
            <Button
              variant="subtle"
              color="gray"
              disabled={form.submitting}
              onClick={() => setOpen(false)}
            >
              Свернуть
            </Button>
            <Button type="submit" loading={form.submitting} disabled={!canPublish}>
              Опубликовать
            </Button>
          </Group>
        </Group>
      </Stack>
    </form>
  );
};

/** Черновик сообщения в текущей вкладке браузера. */
const COMMENT_DRAFT_SCHEMA = z.object({
  values: z.object({ title: z.string(), description: z.string() }),
  requestId: z.string().optional(),
});
