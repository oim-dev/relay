import { useState } from "react";
import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Modal,
  Skeleton,
  Tooltip,
  Tabs,
  Title,
  Badge,
  Text,
} from "@mantine/core";
import { Maximize2, Minimize2, Link2, Check } from "lucide-react";
import { useMediaQuery, useClipboard } from "@mantine/hooks";
import { useBoardTask } from "domains/board-tasks";
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
  const [tab, setTab] = useState<string | null>("task");
  const clipboard = useClipboard({ timeout: 2000 });
  const isMobile = useMediaQuery("(max-width: 48em)");
  const hasError = query.error !== undefined;
  const task = query.data;
  const title = task?.key ?? "Задача";
  const size = isExpanded ? "calc(100vw - 32px)" : "min(1180px, calc(100vw - 48px))";
  const expandLabel = isExpanded ? "Обычный размер" : "Развернуть задачу";
  const SizeIcon = isExpanded ? Minimize2 : Maximize2;
  const offset = isExpanded ? 16 : 24;
  const taskTitle = task?.title || "Без названия";
  const copyLabel = clipboard.copied ? "Ссылка скопирована" : "Копировать ссылку";
  const CopyIcon = clipboard.copied ? Check : Link2;
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
                onOpenedChange={setDeleteOpened}
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
                  <SizeIcon size={18} />
                </ActionIcon>
              </Tooltip>
            )}
            <Modal.CloseButton aria-label="Закрыть задачу" disabled={isDeleteOpened} />
          </Group>
        </Modal.Header>
        <Modal.Body>
          {query.isLoading && <Skeleton height={360} radius="md" />}
          {hasError && (
            <Alert color="red" title="Не удалось прочитать задачу">
              {query.error?.message}
              <Button variant="subtle" onClick={() => void query.mutate().catch(() => undefined)}>
                Повторить
              </Button>
            </Alert>
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
                      <CopyIcon size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
                {task.blocked && (
                  <Badge color="red" variant="light" mt="sm">
                    Есть блокеры
                  </Badge>
                )}
                {clipboard.error && (
                  <Text size="xs" c="red" role="alert">
                    Не удалось скопировать ссылку. Используйте адресную строку.
                  </Text>
                )}
              </div>
              <Tabs.List aria-label="Разделы карточки" className={styles.tabList}>
                <Tabs.Tab value="task">Задача</Tabs.Tab>
                <Tabs.Tab value="comments">Обсуждения</Tabs.Tab>
                <Tabs.Tab value="documents">Документы</Tabs.Tab>
                <Tabs.Tab value="history">История</Tabs.Tab>
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
                <TaskActivity
                  projectId={projectId}
                  taskId={task.id}
                  comments
                  active={tab === "comments"}
                />
              </Tabs.Panel>
              <Tabs.Panel value="documents" className={styles.tabPanel}>
                {tab === "documents" && (
                  <EntityDocuments
                    target={{ kind: "task", id: task.id }}
                    onOpenedChange={setDeleteOpened}
                  />
                )}
              </Tabs.Panel>
              <Tabs.Panel value="history" className={styles.tabPanel}>
                <TaskActivity
                  projectId={projectId}
                  taskId={task.id}
                  comments={false}
                  active={tab === "history"}
                />
              </Tabs.Panel>
            </Tabs>
          )}
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
};
