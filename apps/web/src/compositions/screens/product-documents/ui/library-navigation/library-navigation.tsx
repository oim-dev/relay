import { useRef, useState } from "react";
import { useForm } from "@mantine/form";
import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Modal,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import {
  Library,
  History,
  Pin,
  PencilLine,
  Folder,
  FolderOpen,
  Archive,
  Unlink,
  Settings2,
  Plus,
  ArrowUp,
  ArrowDown,
  X,
} from "lucide-react";
import clsx from "clsx";
import { useProjectId } from "domains/project";
import { isDefined } from "shared/value-predicates";
import { useDeletionRefresh } from "domains/entities";
import { saveLibrarySections, DocumentAccessError } from "domains/documents";
import type { DocumentSection } from "domains/documents";
import type { LibraryNavigationProps } from "./types/library-navigation-props.type";
import styles from "./styles/library-navigation.module.css";

/**
 * Общие представления не являются разделами хранения. «Недавно обновлённые» — вся
 * библиотека в порядке обновления, без порога давности, поэтому собственного счётчика нет.
 */
const VIEWS = [
  { id: "all", label: "Все материалы", icon: Library, hasCount: true },
  { id: "pinned", label: "Закреплённые", icon: Pin, hasCount: true },
  { id: "recent", label: "Недавно обновлённые", icon: History, hasCount: false },
  { id: "draft", label: "Черновики", icon: PencilLine, hasCount: true },
];
/** Служебные представления под разделами. */
const OTHER_VIEWS = [
  { id: "none", label: "Без раздела", icon: FolderOpen, hasCount: true },
  { id: "unattached", label: "Без прикреплений", icon: Unlink, hasCount: true },
  { id: "archived", label: "Архив", icon: Archive, hasCount: true },
];

/**
 * Организует поиск по разделам и позволяет настроить библиотеку проекта.
 *
 * Счётчики приходят с сервера по всей библиотеке, без поиска и фильтров выдачи.
 *
 * Используется для:
 *  - переключения представлений и разделов
 *  - создания, переименования и упорядочивания собственных разделов
 */
export const LibraryNavigation = ({
  settings,
  selected,
  counts,
  countScope,
  onSelect,
}: LibraryNavigationProps) => {
  const projectId = useProjectId();
  const refresh = useDeletionRefresh(projectId);
  const [isOpened, setOpened] = useState(false);
  const [error, setError] = useState("");
  const [defect, setDefect] = useState<Error>();
  const revisionRef = useRef(settings);
  const requestRef = useRef({ fingerprint: "", id: "" });
  const form = useForm<{ sections: DocumentSection[] }>({
    mode: "uncontrolled",
    initialValues: { sections: settings.sections },
    validate: { sections: { name: (name) => (name.trim() === "" ? "Введите название" : null) } },
  });
  const sections = form.useWatchValue("sections");
  const viewItems = VIEWS.map((entry) => ({
    ...entry,
    className: clsx(styles.item, selected === entry.id && styles._active),
    count: entry.hasCount ? counts[entry.id] : undefined,
    isCurrent: selected === entry.id,
  }));
  const sectionItems = settings.sections.map((entry) => ({
    ...entry,
    selectedId: `section:${entry.id}`,
    count: counts[`section:${entry.id}`],
    className: clsx(styles.item, selected === `section:${entry.id}` && styles._active),
    isCurrent: selected === `section:${entry.id}`,
  }));
  const otherItems = OTHER_VIEWS.map((entry) => ({
    ...entry,
    className: clsx(styles.item, selected === entry.id && styles._active),
    count: counts[entry.id],
    isCurrent: selected === entry.id,
  }));
  const editorItems = sections.map((section, index) => ({
    ...section,
    index,
    isFirst: index === 0,
    isLast: index === sections.length - 1,
  }));
  const hasError = error !== "";
  /** Открывает самостоятельный черновик структуры с прочитанной ревизией. */
  const handleOpen = (): void => {
    revisionRef.current = settings;
    form.setValues({ sections: settings.sections });
    setError("");
    setOpened(true);
  };
  /** Сохраняет разделы без изменения содержимого документов. */
  const handleSubmit = async (values: { sections: DocumentSection[] }): Promise<void> => {
    setError("");
    const fingerprint = JSON.stringify([values, revisionRef.current.revision]);
    if (requestRef.current.fingerprint !== fingerprint)
      requestRef.current = { fingerprint, id: crypto.randomUUID() };
    try {
      await saveLibrarySections(
        projectId,
        revisionRef.current,
        values.sections,
        requestRef.current.id,
      );
      await refresh();
      setOpened(false);
    } catch (failure) {
      if (failure instanceof DocumentAccessError) setError(failure.message);
      else setDefect(failure instanceof Error ? failure : new Error("Не удалось изменить разделы"));
    }
  };
  if (defect) throw defect;
  return (
    <nav className={styles.root} aria-label="Разделы библиотеки">
      <p className={styles.scope}>{countScope}</p>
      {viewItems.map((entry) => (
        <UnstyledButton
          key={entry.id}
          className={entry.className}
          aria-current={entry.isCurrent && "page"}
          onClick={() => onSelect(entry.id)}
        >
          <entry.icon size={16} aria-hidden="true" />
          <span className={styles.label}>{entry.label}</span>
          {isDefined(entry.count) && <span className={styles.count}>{entry.count}</span>}
        </UnstyledButton>
      ))}
      <div className={styles.heading}>
        <span>Разделы</span>
        <ActionIcon
          size="sm"
          variant="subtle"
          color="gray"
          aria-label="Настроить разделы"
          onClick={handleOpen}
        >
          <Settings2 size={14} />
        </ActionIcon>
      </div>
      {sectionItems.map((entry) => (
        <UnstyledButton
          key={entry.id}
          className={entry.className}
          aria-current={entry.isCurrent && "page"}
          onClick={() => onSelect(entry.selectedId)}
        >
          <Folder size={16} aria-hidden="true" />
          <span className={styles.label}>{entry.name}</span>
          {isDefined(entry.count) && <span className={styles.count}>{entry.count}</span>}
        </UnstyledButton>
      ))}
      <UnstyledButton className={styles.add} onClick={handleOpen}>
        <Plus size={14} aria-hidden="true" />
        Добавить раздел
      </UnstyledButton>
      <div className={styles.divider} />
      {otherItems.map((entry) => (
        <UnstyledButton
          key={entry.id}
          className={entry.className}
          aria-current={entry.isCurrent && "page"}
          onClick={() => onSelect(entry.id)}
        >
          <entry.icon size={16} aria-hidden="true" />
          <span className={styles.label}>{entry.label}</span>
          {isDefined(entry.count) && <span className={styles.count}>{entry.count}</span>}
        </UnstyledButton>
      ))}
      <Modal
        opened={isOpened}
        onClose={() => setOpened(false)}
        title="Разделы библиотеки"
        size="lg"
        centered
        closeButtonProps={{ "aria-label": "Закрыть настройки разделов" }}
      >
        <form onSubmit={form.onSubmit(handleSubmit)}>
          <Text size="sm" c="dimmed" mb="md">
            Разделы помогают ориентироваться в знаниях проекта. При удалении раздела его документы
            останутся в библиотеке без раздела.
          </Text>
          <fieldset className={styles.fields} disabled={form.submitting}>
            {editorItems.map((entry) => (
              <Group key={entry.id} gap={4} wrap="nowrap" mb="xs">
                <TextInput
                  aria-label={`Название раздела ${entry.index + 1}`}
                  style={{ flex: 1 }}
                  key={form.key(`sections.${entry.index}.name`)}
                  {...form.getInputProps(`sections.${entry.index}.name`)}
                />
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  disabled={entry.isFirst}
                  aria-label={`Выше: ${entry.name}`}
                  onClick={() =>
                    form.reorderListItem("sections", { from: entry.index, to: entry.index - 1 })
                  }
                >
                  <ArrowUp size={14} />
                </ActionIcon>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  disabled={entry.isLast}
                  aria-label={`Ниже: ${entry.name}`}
                  onClick={() =>
                    form.reorderListItem("sections", { from: entry.index, to: entry.index + 1 })
                  }
                >
                  <ArrowDown size={14} />
                </ActionIcon>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label={`Удалить раздел: ${entry.name}`}
                  onClick={() => form.removeListItem("sections", entry.index)}
                >
                  <X size={14} />
                </ActionIcon>
              </Group>
            ))}
            <Button
              variant="subtle"
              size="xs"
              leftSection={<Plus size={14} />}
              disabled={sections.length >= 100}
              onClick={() => form.insertListItem("sections", { id: crypto.randomUUID(), name: "" })}
            >
              Новый раздел
            </Button>
          </fieldset>
          {hasError && (
            <Alert color="red" mt="md">
              {error}
              <Button
                size="xs"
                variant="subtle"
                onClick={() => {
                  revisionRef.current = settings;
                  setError("");
                }}
              >
                Оставить ввод с актуальной версией
              </Button>
            </Alert>
          )}
          <Group justify="flex-end" mt="lg">
            <Button variant="default" onClick={() => setOpened(false)}>
              Отмена
            </Button>
            <Button type="submit" loading={form.submitting}>
              Сохранить разделы
            </Button>
          </Group>
        </form>
      </Modal>
    </nav>
  );
};
