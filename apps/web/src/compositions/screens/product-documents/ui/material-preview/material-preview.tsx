import { Alert, Button, Drawer, Group, Skeleton } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { ArrowUpRight, Pencil } from "lucide-react";
import { Link } from "react-router-dom";
import { useDocument, useLibrarySettings } from "domains/documents";
import { useProjectId } from "domains/project";
import { isDefined } from "shared/value-predicates";
import { PreviewDetails } from "./ui/preview-details/preview-details";
import type { MaterialPreviewProps } from "./types/material-preview-props.type";
import styles from "./styles/material-preview.module.css";

/**
 * Показывает содержание, свойства и использование материала, не покидая каталог.
 * Панель удерживает фокус, закрывается по Escape и возвращает фокус к вызвавшей кнопке.
 *
 * Используется для:
 *  - быстрой проверки материала перед открытием полной карточки
 */
export const MaterialPreview = (props: MaterialPreviewProps) => {
  const { material, opened, href, returnTo, onClose } = props;
  const projectId = useProjectId();
  const isWide = useMediaQuery("(min-width: 48em)");
  const query = useDocument(projectId, opened && isDefined(material) ? material.id : null);
  const settings = useLibrarySettings(projectId);
  const documentData = query.data?.id === material?.id ? query.data : undefined;
  const sectionName =
    settings.data?.sections.find((section) => section.id === documentData?.sectionId)?.name ??
    "Без раздела";
  const isLoading = !isDefined(documentData) && !isDefined(query.error);
  const hasError = !isDefined(documentData) && isDefined(query.error);
  const drawerSize = isWide ? "36rem" : "100%";
  return (
    <Drawer
      opened={opened}
      position="right"
      size={drawerSize}
      title={material?.title ?? "Материал"}
      closeButtonProps={{ "aria-label": "Закрыть предпросмотр" }}
      classNames={{
        content: styles.content,
        header: styles.header,
        title: styles.title,
        body: styles.body,
      }}
      onClose={onClose}
    >
      <Group gap="xs" className={styles.actions}>
        <Button
          component={Link}
          to={href}
          state={{ returnTo }}
          radius="xl"
          rightSection={<ArrowUpRight size={15} aria-hidden="true" />}
        >
          Открыть полностью
        </Button>
        <Button
          component={Link}
          to={`${href}/edit`}
          state={{ returnTo }}
          variant="default"
          radius="xl"
          leftSection={<Pencil size={14} aria-hidden="true" />}
        >
          Редактировать
        </Button>
      </Group>
      {isLoading && (
        <div className={styles.loading}>
          <Skeleton height={18} />
          <Skeleton height={96} />
          <Skeleton height={180} />
        </div>
      )}
      {hasError && (
        <Alert color="orange" title="Не удалось прочитать материал">
          {query.error?.message}
          <Button size="xs" variant="subtle" onClick={() => void query.mutate()}>
            Повторить чтение
          </Button>
        </Alert>
      )}
      {isDefined(documentData) && (
        <PreviewDetails document={documentData} sectionName={sectionName} />
      )}
    </Drawer>
  );
};
