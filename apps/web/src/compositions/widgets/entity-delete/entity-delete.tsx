import { useRef, useState } from "react";
import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { Trash2 } from "lucide-react";
import {
  deleteEntity,
  previewEntityDeletion,
  EntityDeletionError,
  useDeletionRefresh,
} from "domains/entities";
import type { EntityDeletionPreview } from "domains/entities";
import { useProjectId } from "domains/project";
import type { EntityDeleteProps } from "./types/entity-delete-props.type";
import { DeletionList } from "./ui/deletion-list/deletion-list";

/** Объяснение последствий каждого предметного сценария до подтверждения. */
const SCENARIOS = {
  feature:
    "Удалятся фича, её сценарии и их реализации во всех приложениях. Задачи и документы сохранятся без ссылок на удалённые записи.",
  scenario:
    "Удалятся сценарий и его реализации. Фича, задачи и документы сохранятся, ссылки на удалённые записи снимутся.",
  application:
    "Удалятся приложение, его реализации, доска и все задачи этой доски. Другие доски и задачи сохранятся, зависимости от удалённых записей снимутся.",
  implementation:
    "Удалится выбранная реализация. Для реализации фичи также удалятся реализации её сценариев в этом приложении. Общие требования и задачи сохранятся.",
  task: "Удалится карточка с критериями и обсуждениями. Подзадачи сохранятся без родителя; зависимости и связи с другими записями снимутся.",
  document:
    "Удалятся документ и его связи. Задачи и другие сущности, к которым он прикреплён, сохранятся.",
} as const;

/**
 * Показывает предметный каскад и подтверждает удаление просмотренного состояния.
 *
 * Используется для:
 *  - удаления из страниц продукта и окна задачи с безопасным повтором
 */
export const EntityDelete = (props: EntityDeleteProps) => {
  const { entityId, kind, onDeleted, onOpenedChange } = props;
  const projectId = useProjectId();
  const refresh = useDeletionRefresh(projectId);
  const [isOpened, setOpened] = useState(false);
  const [isLoading, setLoading] = useState(false);
  const [isDeleting, setDeleting] = useState(false);
  const [preview, setPreview] = useState<EntityDeletionPreview | null>(null);
  const [message, setMessage] = useState("");
  const [shouldRefresh, setShouldRefresh] = useState(false);
  const [unexpectedError, setUnexpectedError] = useState<Error | null>(null);
  const requestId = useRef<string | null>(null);
  const isBusy = isLoading || isDeleting;
  const hasPreview = preview !== null;
  const hasMessage = message !== "";
  const canDelete = hasPreview && !shouldRefresh && !isBusy;
  const canLoad = !hasPreview || shouldRefresh;
  const title = preview === null ? "Удаление сущности" : `Удалить «${preview.target.title}»?`;
  const deletedItems = preview?.deleted ?? [];
  const detachedItems = preview?.detached ?? [];
  const description = SCENARIOS[kind];

  /**
   * Согласует клавиатуру и фокус вложенного подтверждения с окном задачи.
   */
  const handleOpenedChange = (isNextOpened: boolean): void => {
    setOpened(isNextOpened);
    onOpenedChange?.(isNextOpened);
  };

  /**
   * Загружает новый состав только по явному действию и сбрасывает прежнее подтверждение.
   */
  const handleLoad = async (): Promise<void> => {
    if (isBusy) return;
    handleOpenedChange(true);
    setLoading(true);
    setMessage("");
    setPreview(null);
    setShouldRefresh(false);
    requestId.current = null;
    try {
      setPreview(await previewEntityDeletion(projectId, { ref: `${kind}:${entityId}`, kind }));
    } catch (failure) {
      if (failure instanceof EntityDeletionError) setMessage(failure.message);
      else
        setUnexpectedError(failure instanceof Error ? failure : new Error("Ошибка предпросмотра"));
    } finally {
      setLoading(false);
    }
  };

  /**
   * Сетевой повтор отправляет прежнюю версию и requestId, а не новый каскад.
   */
  const handleDelete = async (): Promise<void> => {
    if (preview === null || !canDelete) return;
    setDeleting(true);
    setMessage("");
    requestId.current ??= crypto.randomUUID();
    try {
      await deleteEntity(projectId, {
        kind,
        ref: `${kind}:${entityId}`,
        ifVersion: preview.version,
        requestId: requestId.current,
      });
    } catch (failure) {
      if (failure instanceof EntityDeletionError) {
        setMessage(failure.message);
        setShouldRefresh(failure.shouldRefresh);
      } else setUnexpectedError(failure instanceof Error ? failure : new Error("Ошибка удаления"));
      setDeleting(false);
      return;
    }
    handleOpenedChange(false);
    setDeleting(false);
    onDeleted();
    void refresh().catch(() => undefined);
  };

  if (unexpectedError !== null) throw unexpectedError;

  return (
    <>
      <Button
        color="red"
        variant="subtle"
        leftSection={<Trash2 size={15} aria-hidden="true" />}
        onClick={() => {
          if (preview === null) void handleLoad();
          else handleOpenedChange(true);
        }}
      >
        Удалить
      </Button>
      <Modal.Root
        opened={isOpened}
        onClose={() => {
          if (!isDeleting) handleOpenedChange(false);
        }}
        centered
        size="lg"
        closeOnClickOutside={!isDeleting}
        closeOnEscape={!isDeleting}
        zIndex={400}
      >
        <Modal.Overlay />
        <Modal.Content>
          <Modal.Header role="presentation">
            <Modal.Title>{title}</Modal.Title>
            <Modal.CloseButton disabled={isDeleting} aria-label="Закрыть подтверждение удаления" />
          </Modal.Header>
          <Modal.Body>
            <Stack gap="md">
              <Text size="sm">{description}</Text>
              <Text size="sm" c="dimmed">
                Восстановление после удаления не предусмотрено.
              </Text>
              {hasMessage && (
                <Alert color="red" role="alert">
                  {message}
                </Alert>
              )}
              {hasPreview && (
                <>
                  <DeletionList title="Будут удалены" entries={deletedItems} maxHeight={200} />
                  <DeletionList
                    title="Сохранятся со снятием связей"
                    entries={detachedItems}
                    maxHeight={140}
                  />
                  <Text size="sm" c="dimmed">
                    Связей графа будет снято: {preview.relations}
                  </Text>
                </>
              )}
              <Group justify="flex-end">
                <Button
                  variant="default"
                  disabled={isDeleting}
                  onClick={() => handleOpenedChange(false)}
                  data-autofocus
                >
                  Отмена
                </Button>
                {canLoad && (
                  <Button variant="default" loading={isLoading} onClick={() => void handleLoad()}>
                    Обновить предпросмотр
                  </Button>
                )}
                <Button
                  color="red.8"
                  disabled={!canDelete}
                  loading={isDeleting}
                  onClick={() => void handleDelete()}
                >
                  Подтвердить удаление
                </Button>
              </Group>
            </Stack>
          </Modal.Body>
        </Modal.Content>
      </Modal.Root>
    </>
  );
};
