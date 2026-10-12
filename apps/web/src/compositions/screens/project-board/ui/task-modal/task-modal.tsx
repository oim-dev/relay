import { useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Button,
  Group,
  Modal,
  Skeleton,
  Tooltip,
  Tabs,
  Title,
  Text,
} from "@mantine/core";
import { Maximize2, Minimize2, Link2, Check, LockKeyhole } from "lucide-react";
import { useMediaQuery, useClipboard } from "@mantine/hooks";
import { BoardTaskNotFoundError, useBoardTask } from "domains/board-tasks";
import { StatePanel } from "ui/state-panel";
import { StatusBadge } from "ui/status-badge";
import { EntityDelete } from "compositions/widgets/entity-delete";
import { EntityDocuments } from "compositions/widgets/entity-documents";
import { TaskEditor } from "./ui/task-editor";
import { TaskActivity } from "./ui/task-activity";
import type { TaskModalProps } from "./types/task-modal-props.type";
import styles from "./styles/task-modal.module.css";

/**
 * Открывает задачу в широком центральном модальном окне.
 *
 * Используется для:
 *  - загрузки задачи по ID или ключу и полноэкранного редактора на телефоне
 */
export const TaskModal = (props: TaskModalProps) => {
  const { projectId, reference, startEditing, onClose, onOpen } = props;
  const query = useBoardTask(projectId, reference, !startEditing);
  const [isExpanded, setExpanded] = useState(false);
  const [isDeleteOpened, setDeleteOpened] = useState(false);
  const nestedOpenerRef = useRef<HTMLElement | null>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<string | null>("task");
  const clipboard = useClipboard({ timeout: 2000 });
  const isMobile = useMediaQuery("(max-width: 48em)");
  // Отсутствующая задача — не сбой чтения: повтор не вернёт её, предлагается только возврат.
  const isMissing = query.error instanceof BoardTaskNotFoundError;
  const hasError = query.error !== undefined && !isMissing;
  const task = query.data;
  const title = task?.key ?? "Задача";
  const size = isExpanded ? "calc(100vw - 2rem)" : "min(73.75rem, calc(100vw - 3rem))";
  const expandLabel = isExpanded ? "Обычный размер" : "Развернуть задачу";
  const SizeIcon = isExpanded ? Minimize2 : Maximize2;
  const offset = isExpanded ? 16 : 24;
  const taskTitle = task?.title || "Без названия";
  // Начальный фокус окна: вкладка «Задача», а у новой задачи — поле заголовка редактора.
  const tabAutofocus = startEditing ? undefined : true;
  const copyLabel = clipboard.copied ? "Ссылка скопирована" : "Копировать ссылку";
  const CopyIcon = clipboard.copied ? Check : Link2;
  /**
   * Вложенное окно (подтверждение удаления, выбор материала) временно снимает ловушку фокуса
   * этого окна. Запоминает вызвавший элемент, чтобы вернуть к нему фокус после закрытия.
   */
  const handleNestedOpenedChange = (isNextOpened: boolean): void => {
    if (isNextOpened && document.activeElement instanceof HTMLElement)
      nestedOpenerRef.current = document.activeElement;
    setDeleteOpened(isNextOpened);
  };
  useEffect(() => {
    if (isDeleteOpened || nestedOpenerRef.current === null) return;
    const opener = nestedOpenerRef.current;
    nestedOpenerRef.current = null;
    // Ловушка окна при повторном включении переводит фокус на начальный элемент;
    // возврат выполняется следующей задачей, после неё.
    const timer = window.setTimeout(() => {
      if (opener.isConnected) opener.focus({ preventScroll: true });
    });
    return () => window.clearTimeout(timer);
  }, [isDeleteOpened]);
  // Ответ об отсутствии приходит после открытия окна: фокус переходит к единственному действию.
  useEffect(() => {
    if (isMissing) backButtonRef.current?.focus({ preventScroll: true });
  }, [isMissing]);
  const taskUrl = task
    ? `${window.location.origin}/projects/${encodeURIComponent(projectId)}/boards/${encodeURIComponent(task.boardSlug)}/${task.id}`
    : "";
  return (
    <Modal.Root
      opened
      onClose={onClose}
      closeOnEscape={!isDeleteOpened}
      closeOnClickOutside={!isDeleteOpened}
      trapFocus={!isDeleteOpened}
      centered
      size={size}
      xOffset={offset}
      yOffset={offset}
      fullScreen={isMobile}
      classNames={{
        body: styles.body,
        header: styles.header,
        title: styles.title,
        content: styles.content,
      }}
    >
      <Modal.Overlay />
      <Modal.Content data-expanded={isExpanded}>
        <Modal.Header role="presentation">
          <Modal.Title>{title}</Modal.Title>
          <Group gap="xs">
            {task !== undefined && (
              <EntityDelete
                key={task.id}
                kind="task"
                entityId={task.id}
                onDeleted={onClose}
                onOpenedChange={handleNestedOpenedChange}
              />
            )}
            {!isMobile && (
              <Tooltip label={expandLabel}>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label={expandLabel}
                  aria-pressed={isExpanded}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setExpanded(!isExpanded)}
                >
                  <SizeIcon size={18} aria-hidden="true" />
                </ActionIcon>
              </Tooltip>
            )}
            <Modal.CloseButton aria-label="Закрыть задачу" disabled={isDeleteOpened} />
          </Group>
        </Modal.Header>
        <Modal.Body>
          {query.isLoading && (
            <Skeleton height="22.5rem" width="auto" radius="xl" className={styles.state} />
          )}
          {isMissing && (
            <StatePanel
              title="Задача не найдена"
              description="В проекте нет задачи с таким адресом: её удалили или адрес неверен."
              action={
                <Button ref={backButtonRef} variant="default" data-autofocus onClick={onClose}>
                  К доске
                </Button>
              }
              className={styles.state}
            />
          )}
          {hasError && (
            <StatePanel
              state="error"
              title="Не удалось прочитать задачу"
              description={query.error?.message ?? "Сервер не ответил на запрос задачи."}
              action={
                <Button
                  variant="default"
                  onClick={() => void query.mutate().catch(() => undefined)}
                >
                  Повторить
                </Button>
              }
              className={styles.state}
            />
          )}
          {task !== undefined && (
            <Tabs value={tab} onChange={setTab} keepMounted key={task.id} className={styles.tabs}>
              <div className={styles.heading}>
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Title order={2} className={styles.taskTitle}>
                    {taskTitle}
                  </Title>
                  <Tooltip label={copyLabel}>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label={copyLabel}
                      onClick={() => clipboard.copy(taskUrl)}
                    >
                      <CopyIcon size={16} aria-hidden="true" />
                    </ActionIcon>
                  </Tooltip>
                </Group>
                {task.blocked && (
                  <StatusBadge
                    tone="danger"
                    icon={<LockKeyhole size={12} aria-hidden="true" />}
                    className={styles.blocked}
                  >
                    Есть блокеры
                  </StatusBadge>
                )}
                {clipboard.error && (
                  <Text size="xs" c="danger" role="alert">
                    Не удалось скопировать ссылку. Используйте адресную строку.
                  </Text>
                )}
              </div>
              <Tabs.List aria-label="Разделы карточки" className={styles.tabList}>
                <Tabs.Tab value="task" data-autofocus={tabAutofocus}>
                  Задача
                </Tabs.Tab>
                <Tabs.Tab value="comments">Обсуждения</Tabs.Tab>
                <Tabs.Tab value="documents">Материалы</Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel value="task" className={styles.tabPanel}>
                <TaskEditor
                  key={task.id}
                  projectId={projectId}
                  task={task}
                  startEditing={startEditing}
                  onOpen={onOpen}
                  onClose={onClose}
                />
              </Tabs.Panel>
              <Tabs.Panel value="comments" className={styles.tabPanel}>
                <TaskActivity projectId={projectId} taskId={task.id} active={tab === "comments"} />
              </Tabs.Panel>
              <Tabs.Panel value="documents" className={styles.tabPanel}>
                {tab === "documents" && (
                  <EntityDocuments
                    target={{ kind: "task", id: task.id }}
                    targetTitle={taskTitle}
                    onOpenedChange={handleNestedOpenedChange}
                  />
                )}
              </Tabs.Panel>
            </Tabs>
          )}
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
};
