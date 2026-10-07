import { useState } from "react";
import { Alert, Button, Drawer, Group, Select, Skeleton, Text, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { Search, Plus, PanelLeft, BookOpen, ArrowLeft, ArrowRight } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { useEntities } from "domains/entities";
import { DOCUMENT_KIND_OPTIONS, useLibrarySettings } from "domains/documents";
import { useProjectId, useProjectBasePath } from "domains/project";
import { ProductPage } from "compositions/widgets/product-page";
import { StatePanel } from "ui/state-panel";
import { EntityPicker } from "compositions/widgets/entity-picker";
import { isEmptyArray } from "shared/value-predicates";
import { DocumentCard } from "./ui/document-card";
import { LibraryNavigation } from "./ui/library-navigation";
import styles from "./styles/product-documents.module.css";

/** Названия системных представлений библиотеки. */
const VIEW_LABELS: Record<string, string> = {
  all: "Все документы",
  draft: "Черновики",
  pinned: "Закреплённые",
  none: "Без раздела",
  archived: "Архив",
};

/**
 * Собирает проектную библиотеку с серверным поиском и независимыми разделами.
 *
 * Используется для:
 *  - ориентации в знаниях проекта и черновом проектировании
 *  - поиска материалов с сохранением фильтров в URL
 */
export const ProductDocumentsScreen = () => {
  const projectId = useProjectId();
  const base = useProjectBasePath();
  const settings = useLibrarySettings(projectId);
  const [params, setParams] = useSearchParams();
  const [isNavigationOpen, setNavigationOpen] = useState(false);
  const query = params.get("q") ?? "";
  const [search] = useDebouncedValue(query, 200);
  const view = params.get("view") ?? "all";
  const section = params.get("section");
  const requestedKind = params.get("kind");
  const selectedKind = DOCUMENT_KIND_OPTIONS.find((entry) => entry.value === requestedKind)?.value;
  const sort = params.get("sort") === "title" ? "title" : "updated";
  const offset = Math.max(0, Number.parseInt(params.get("offset") ?? "0", 10) || 0);
  const response = useEntities(projectId, {
    kind: "document",
    q: search,
    sort,
    offset,
    limit: 40,
    ...(params.get("version") ? { version: params.get("version") ?? undefined } : {}),
    ...(selectedKind ? { documentKind: selectedKind } : {}),
    ...(section ? { section } : view === "none" ? { section: "none" } : {}),
    ...(view === "draft" ? { status: "draft" } : {}),
    ...(view === "pinned" ? { pinned: "true" } : {}),
    archived: view === "archived" ? "true" : "false",
    ...(params.get("target") ? { target: params.get("target") ?? undefined } : {}),
  });
  const sections = settings.data?.sections ?? [];
  const selected = section ? `section:${section}` : view;
  const title = section
    ? (sections.find((entry) => entry.id === section)?.name ?? "Раздел")
    : (VIEW_LABELS[view] ?? "Все документы");
  const counts = response.data?.libraryCounts ?? {};
  const documentItems = response.data?.items ?? [];
  // Отказ чтения без данных не выдаётся за пустой результат.
  const shownLabel =
    response.data === undefined
      ? "Показано: —"
      : `Показано ${documentItems.length} из ${response.data.total}`;
  const hasNoResults = !response.isLoading && !response.error && isEmptyArray(documentItems);
  const hasFilters = query !== "" || selectedKind !== undefined || params.has("target");
  const hasSettings = settings.data !== undefined;
  const hasPrevious = offset > 0;
  const hasMore = response.data?.nextOffset !== null && response.data?.nextOffset !== undefined;
  const hasError = response.error !== undefined || settings.error !== undefined;
  const errorMessage = response.error?.message ?? settings.error?.message;
  const returnTo = `${base}/documents${params.size > 0 ? `?${params}` : ""}`;
  const createHref = `${base}/documents/new${section ? `?section=${encodeURIComponent(section)}` : ""}`;
  const emptyTitle = hasFilters ? "Ничего не нашлось" : "Здесь пока нет документов";
  const emptyDescription = hasFilters
    ? "Попробуйте другое название или расширьте область поиска."
    : "Сохраните полезное знание, инструкцию или начните проектировать решение в черновике.";
  /** Изменяет фильтр и начинает новую согласованную выдачу. */
  const updateFilter = (name: string, value: string | null): void => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("offset");
        next.delete("version");
        if (value === null || value === "") next.delete(name);
        else next.set(name, value);
        return next;
      },
      { replace: true },
    );
  };
  /** Переключает локальную область, сохраняя запрос пользователя. */
  const handleSelect = (value: string): void => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("section");
      next.delete("view");
      next.delete("offset");
      next.delete("version");
      if (value.startsWith("section:")) next.set("section", value.slice(8));
      else if (value !== "all") next.set("view", value);
      return next;
    });
    setNavigationOpen(false);
  };
  /** Дочитывает страницы одной версии без неявной полной загрузки. */
  const handlePage = (nextOffset: number): void => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set("offset", String(nextOffset));
      if (response.data) next.set("version", response.data.version);
      return next;
    });
  };
  return (
    <ProductPage
      title="Библиотека знаний"
      description="Контекст, решения и инструкции — общая память проекта."
      actions={
        <Button
          component={Link}
          to={createHref}
          state={{ returnTo }}
          leftSection={<Plus size={16} />}
        >
          Документ
        </Button>
      }
    >
      <div className={styles.root}>
        <aside className={styles.sidebar}>
          {hasSettings && (
            <LibraryNavigation
              settings={settings.data!}
              selected={selected}
              counts={counts}
              onSelect={handleSelect}
            />
          )}
        </aside>
        <div className={styles.main}>
          <div className={styles.mobileNavigation}>
            <Button
              variant="default"
              leftSection={<PanelLeft size={16} />}
              onClick={() => setNavigationOpen(true)}
            >
              Разделы библиотеки
            </Button>
          </div>
          <div className={styles.toolbar}>
            <TextInput
              className={styles.search}
              aria-label="Поиск документов"
              placeholder="Найти в знаниях проекта…"
              leftSection={<Search size={16} />}
              value={query}
              onChange={(event) => updateFilter("q", event.currentTarget.value)}
            />
            <Select
              aria-label="Тип документа"
              placeholder="Все типы"
              clearable
              value={selectedKind ?? null}
              data={DOCUMENT_KIND_OPTIONS}
              onChange={(value) => updateFilter("kind", value)}
            />
          </div>
          <div className={styles.contextFilter}>
            <EntityPicker
              projectId={projectId}
              label="Связано с"
              placeholder="Любая сущность проекта"
              value={params.get("target")}
              onChange={(value) => updateFilter("target", value)}
            />
          </div>
          <div className={styles.listHeading}>
            <h2 className={styles.title}>
              {title}
              <span>{response.data?.total ?? "—"}</span>
            </h2>
            <Select
              aria-label="Порядок документов"
              size="xs"
              className={styles.sort}
              value={sort}
              data={[
                { value: "updated", label: "Сначала обновлённые" },
                { value: "title", label: "По названию" },
              ]}
              onChange={(value) => updateFilter("sort", value)}
            />
          </div>
          {hasFilters && (
            <Group gap="xs" mb="sm">
              <Text size="xs" c="dimmed">
                Поиск в выбранной области
              </Text>
              <Button variant="subtle" size="compact-xs" onClick={() => setParams({})}>
                Сбросить фильтры
              </Button>
            </Group>
          )}
          {hasError && (
            <Alert color="orange" title="Не удалось обновить библиотеку" mb="md">
              {errorMessage}
              <Button
                variant="subtle"
                size="xs"
                onClick={() => {
                  updateFilter("offset", null);
                  void response.mutate();
                  void settings.mutate();
                }}
              >
                Обновить список
              </Button>
            </Alert>
          )}
          {response.isLoading && (
            <div className={styles.loading}>
              <Skeleton height={100} />
              <Skeleton height={100} />
              <Skeleton height={100} />
            </div>
          )}
          {hasNoResults && (
            <div className={styles.empty}>
              <BookOpen size={32} strokeWidth={1.25} aria-hidden="true" />
              <StatePanel
                title={emptyTitle}
                description={emptyDescription}
                action={
                  <Button component={Link} to={createHref} variant="default" state={{ returnTo }}>
                    Создать документ
                  </Button>
                }
              />
            </div>
          )}
          <ul className={styles.list} aria-label="Документы проекта">
            {documentItems.map((document) => (
              <li key={document.ref.id}>
                <DocumentCard
                  document={document}
                  sectionName={
                    sections.find((entry) => entry.id === document.document?.sectionId)?.name ??
                    "Без раздела"
                  }
                  href={`${base}/documents/${document.ref.id}`}
                  returnTo={returnTo}
                />
              </li>
            ))}
          </ul>
          <footer className={styles.footer}>
            <Text size="xs" c="dimmed" role="status">
              {shownLabel}
            </Text>
            <Group gap="xs">
              <Button
                size="xs"
                variant="subtle"
                color="gray"
                leftSection={<ArrowLeft size={13} />}
                disabled={!hasPrevious}
                onClick={() => handlePage(Math.max(0, offset - 40))}
              >
                Назад
              </Button>
              <Button
                size="xs"
                variant="subtle"
                color="gray"
                rightSection={<ArrowRight size={13} />}
                disabled={!hasMore}
                onClick={() => handlePage(response.data?.nextOffset ?? 0)}
              >
                Далее
              </Button>
            </Group>
          </footer>
        </div>
      </div>
      <Drawer
        opened={isNavigationOpen}
        onClose={() => setNavigationOpen(false)}
        title="Библиотека знаний"
        size="xs"
      >
        {hasSettings && (
          <LibraryNavigation
            settings={settings.data!}
            selected={selected}
            counts={counts}
            onSelect={handleSelect}
          />
        )}
      </Drawer>
    </ProductPage>
  );
};
