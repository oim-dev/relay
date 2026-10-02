import { useEffect, useId, useState } from "react";
import { ActionIcon, Button, Drawer, Tooltip } from "@mantine/core";
import { useDebouncedValue, useMediaQuery } from "@mantine/hooks";
import { PanelLeftClose, PanelLeftOpen, RefreshCw } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import {
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  MATERIAL_FORMATS,
  DocumentConflictError,
  DocumentOutcomeUnknownError,
  useLibrarySettings,
  useMaterialCatalog,
  useMaterialFacets,
} from "domains/documents";
import type { MaterialSort } from "domains/documents";
import { useProjectBasePath, useProjectId } from "domains/project";
import { PageStage } from "ui/page-stage";
import { isDefined, isEmptyArray } from "shared/value-predicates";
import { BULK_LIMIT, SCOPE_PARAMS, VIEW_LABELS } from "./config/library.config";
import { getNavigationCounts } from "./helpers/get-navigation-counts";
import { readLibraryParams } from "./helpers/read-library-params";
import { uniqueMaterials } from "./helpers/unique-materials";
import { useBulkSelection } from "./hooks/use-bulk-selection.hook";
import { useCatalogVolume } from "./hooks/use-catalog-volume.hook";
import { useLibraryReturn } from "./hooks/use-library-return.hook";
import { useMaterialActions } from "./hooks/use-material-actions.hook";
import { usePanelPreference } from "./hooks/use-panel-preference.hook";
import { BulkActions } from "./ui/bulk-actions/bulk-actions";
import { BulkResult } from "./ui/bulk-result/bulk-result";
import { CatalogState } from "./ui/catalog-state/catalog-state";
import { LibraryFilters } from "./ui/library-filters/library-filters";
import { LibraryHeader } from "./ui/library-header/library-header";
import { LibraryNavigation } from "./ui/library-navigation";
import { LibraryNotice } from "./ui/library-notice/library-notice";
import { MaterialList } from "./ui/material-list";
import type { CatalogMaterial } from "./ui/material-list";
import { MaterialPreview } from "./ui/material-preview";
import { SearchScope } from "./ui/search-scope/search-scope";
import styles from "./styles/product-documents.module.css";

/** Параметры адреса прежней постраничной навигации, заменённые продолжением выдачи. */
const LEGACY_PARAMS = ["offset", "version"];

/**
 * Собирает каталог материалов проекта: разделы и представления, поиск с понятной областью,
 * компактную выдачу с продолжением, быстрый предпросмотр и быстрые действия.
 * Условия, порядок и показанный объём хранятся в адресе.
 *
 * Используется для:
 *  - поиска и выбора материала в библиотеке знаний
 *  - упорядочивания материалов без открытия редактора
 */
export const ProductDocumentsScreen = () => {
  const projectId = useProjectId();
  const base = useProjectBasePath();
  const settings = useLibrarySettings(projectId);
  const [params, setParams] = useSearchParams();
  const [isNavigationOpen, setNavigationOpen] = useState(false);
  const [isFiltersOpen, setFiltersOpen] = useState(false);
  const [isFilterPanelOpen, setFilterPanelOpen] = usePanelPreference("filters-open", false);
  const [isSidebarCollapsed, setSidebarCollapsed] = usePanelPreference(
    "navigation-collapsed",
    false,
  );
  const filtersPanelId = useId();
  const sidebarNavigationId = useId();
  const [preview, setPreview] = useState<{ id: string; title: string } | null>(null);
  const [isPreviewOpen, setPreviewOpen] = useState(false);
  const isWide = useMediaQuery("(min-width: 75em)", true, { getInitialValueInEffect: false });
  const isMedium = useMediaQuery("(min-width: 48em)", true, { getInitialValueInEffect: false });
  const { filters: requested, pages: requestedPages } = readLibraryParams(params);
  const search = params.toString();
  const returnTo = `${base}/documents${search === "" ? "" : `?${search}`}`;
  const volume = useCatalogVolume(
    projectId,
    JSON.stringify([projectId, requested]),
    returnTo,
    requestedPages,
  );
  const [debouncedQuery] = useDebouncedValue(requested.q.trim(), 250);
  const filters = { ...requested, q: debouncedQuery };
  const catalog = useMaterialCatalog(projectId, filters, volume.pages);
  const navigationFilters = { ...filters, view: "all" as const, section: null, status: null };
  const navigationFacets = useMaterialFacets(projectId, navigationFilters);
  const filterFacets = useMaterialFacets(projectId, filters);
  const actions = useMaterialActions(projectId);
  const rememberMaterial = useLibraryReturn(projectId, returnTo, isDefined(catalog.data));
  const hasLegacyParams = LEGACY_PARAMS.some((name) => params.has(name));
  useEffect(() => {
    if (!hasLegacyParams) return;
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        LEGACY_PARAMS.forEach((name) => next.delete(name));
        return next;
      },
      { replace: true },
    );
  }, [hasLegacyParams, setParams]);

  const pageList = catalog.data ?? [];
  const firstPage = pageList.at(0);
  const lastPage = pageList.at(-1);
  const materialItems = uniqueMaterials(pageList);
  const libraryCounts = firstPage?.counts ?? {};
  const counts = getNavigationCounts(navigationFacets.data);
  const scopeKey = JSON.stringify({ ...filters, sort: null });
  const bulk = useBulkSelection(projectId, scopeKey);
  const sections = settings.data?.sections ?? [];
  const sectionName = sections.find((section) => section.id === filters.section)?.name;
  const areaTitle = isDefined(filters.section)
    ? (sectionName ?? "Раздел")
    : VIEW_LABELS[filters.view];
  const selected = isDefined(filters.section) ? `section:${filters.section}` : filters.view;
  const isSortFixed = filters.view === "recent" && !isDefined(filters.section);
  const sort: MaterialSort = isSortFixed ? "updated" : filters.sort;
  const catalogError = catalog.error;
  /* После ошибки чтения продолжение недоступно, пока список не перечитан. */
  const hasMore = isDefined(lastPage) && lastPage.nextOffset !== null && !isDefined(catalogError);
  const isLoadingMore = catalog.size > pageList.length && isDefined(firstPage);
  const isFirstLoading = !isDefined(catalog.data) && !isDefined(catalog.error);
  const tagList = filters.tags ?? [];
  const isStatusFixed =
    (filters.view === "draft" || filters.view === "archived") && !isDefined(filters.section);
  const filterCount =
    Number(isDefined(filters.kind)) +
    Number(isDefined(filters.target)) +
    Number(isDefined(filters.format)) +
    Number(isDefined(filters.status) && !isStatusFixed) +
    tagList.length;
  const hasCountFilters =
    filters.q !== "" ||
    isDefined(filters.kind) ||
    isDefined(filters.target) ||
    isDefined(filters.format) ||
    tagList.length > 0;
  const countScope = hasCountFilters
    ? "Числа учитывают поиск, тип, формат, теги и прикрепление"
    : "Числа — по всей библиотеке";
  const isNarrow = filters.view !== "all" || isDefined(filters.section) || filterCount > 0;
  const hasQuery = requested.q.trim() !== "";
  const shouldShowScope = hasQuery || filterCount > 0;
  const scopeParts = [
    isDefined(filters.section) ? `раздел «${areaTitle}»` : VIEW_LABELS[filters.view],
    ...(isDefined(filters.kind) ? [`тип «${DOCUMENT_KINDS[filters.kind]}»`] : []),
    ...(isDefined(filters.format) ? [`формат «${MATERIAL_FORMATS[filters.format]}»`] : []),
    ...(isDefined(filters.status) && !isStatusFixed
      ? [`состояние «${DOCUMENT_STATUSES[filters.status]}»`]
      : []),
    ...(tagList.length > 0 ? [`все теги: ${tagList.join(", ")}`] : []),
    ...(isDefined(filters.target) ? ["прикреплённые к выбранной записи"] : []),
  ];
  const libraryTotal = (libraryCounts.all ?? 0) + (libraryCounts.archived ?? 0);
  const selectedList = [...bulk.selected.values()];
  const selectedTags = [...new Set(selectedList.flatMap((material) => material.tags))];
  const hasSelection = bulk.selected.size > 0;
  const isLibraryEmpty = isDefined(firstPage) && libraryTotal === 0;
  const isResultEmpty = isDefined(firstPage) && isEmptyArray(materialItems);
  const isConflict = catalogError instanceof DocumentConflictError;
  const sidebarToggleLabel = isSidebarCollapsed ? "Развернуть разделы" : "Свернуть разделы";
  const SidebarToggleIcon = isSidebarCollapsed ? PanelLeftOpen : PanelLeftClose;
  const hasSidebar = isWide && isDefined(settings.data);
  const sidebarState = hasSidebar ? (isSidebarCollapsed ? "collapsed" : "expanded") : "none";
  const isFiltersShown = isMedium ? isFilterPanelOpen : isFiltersOpen;
  const filtersControls = isMedium ? filtersPanelId : undefined;
  const createHref = `${base}/documents/new${
    isDefined(filters.section) ? `?section=${encodeURIComponent(filters.section)}` : ""
  }`;

  /** Меняет условия выдачи и начинает её заново с первой порции. */
  const updateParams = (
    changes: Record<string, string | string[] | null>,
    replace = false,
  ): void => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("pages");
        LEGACY_PARAMS.forEach((name) => next.delete(name));
        Object.entries(changes).forEach(([name, value]) => {
          next.delete(name);
          if (Array.isArray(value)) value.forEach((entry) => next.append(name, entry));
          else if (value !== null && value !== "") next.set(name, value);
        });
        return next;
      },
      { replace },
    );
  };
  /** Переключает раздел или представление, сохраняя строку поиска и фильтры. */
  const handleSelect = (value: string): void => {
    const isSection = value.startsWith("section:");
    updateParams({
      section: isSection ? value.slice("section:".length) : null,
      view: isSection || value === "all" ? null : value,
    });
    setNavigationOpen(false);
  };
  /** Ищет ту же строку по всей библиотеке, снимая раздел, представление и фильтры. */
  const handleSearchEverywhere = (): void => {
    updateParams(Object.fromEntries(SCOPE_PARAMS.map((name) => [name, null])));
  };
  /** Сбрасывает поиск и все условия области. */
  const handleReset = (): void => {
    updateParams(Object.fromEntries([...SCOPE_PARAMS, "q"].map((name) => [name, null])));
  };
  /** Показывает фильтры над выдачей либо, на телефоне, в выдвижной панели. */
  const handleToggleFilters = (): void => {
    if (isMedium) setFilterPanelOpen(!isFilterPanelOpen);
    else setFiltersOpen(true);
  };
  /** Открывает предпросмотр выбранного материала. */
  const handlePreview = (material: CatalogMaterial): void => {
    setPreview({ id: material.ref.id, title: material.title });
    setPreviewOpen(true);
  };

  const filterProps = {
    projectId,
    facets: filterFacets.data,
    kind: filters.kind,
    format: filters.format ?? null,
    status: filters.status ?? null,
    isStatusFixed,
    tags: tagList,
    target: filters.target,
    onChange: (name: "kind" | "format" | "status" | "target", value: string | null) =>
      updateParams({ [name]: value }),
    onTagsChange: (tags: string[]) => updateParams({ tags }),
  };
  const retryButton = (
    <Button
      size="xs"
      variant="default"
      radius="xl"
      leftSection={<RefreshCw size={13} aria-hidden="true" />}
      loading={catalog.isValidating}
      onClick={() => void catalog.mutate()}
    >
      Перечитать список
    </Button>
  );
  /* Пока показана ошибка чтения, перечитывание предлагает её сообщение, а не отчёт о записи. */
  const refreshAfterWrite = isDefined(catalogError) ? undefined : () => void catalog.mutate();
  const actionNoticeRetry =
    actions.notice?.tone === "warning" && !isDefined(catalogError) ? retryButton : undefined;
  const resultKind = isFirstLoading
    ? "loading"
    : isLibraryEmpty
      ? "empty-library"
      : isResultEmpty
        ? "empty-result"
        : null;
  const resultState = isDefined(resultKind) && (
    <CatalogState
      kind={resultKind}
      createHref={createHref}
      returnTo={returnTo}
      canSearchEverywhere={isNarrow && hasQuery}
      onSearchEverywhere={handleSearchEverywhere}
      onReset={handleReset}
    />
  );
  const errorTitle = isConflict ? "Список изменился" : "Не удалось прочитать список";
  const errorMessage = isConflict
    ? "Пока читалось продолжение, материалы изменились. Перечитайте список: показанный объём сохранится."
    : catalogError instanceof DocumentOutcomeUnknownError
      ? "Ответ сервера не получен или не прочитан. Проверьте соединение и перечитайте список."
      : (catalogError?.message ?? "");

  return (
    <PageStage>
      <LibraryHeader
        query={requested.q}
        createHref={createHref}
        returnTo={returnTo}
        filterCount={filterCount}
        isFiltersExpanded={isFiltersShown}
        filtersControls={filtersControls}
        onQueryChange={(value) => updateParams({ q: value }, true)}
        onOpenNavigation={() => setNavigationOpen(true)}
        onToggleFilters={handleToggleFilters}
      />
      <div className={styles.layout} data-sidebar={sidebarState}>
        {hasSidebar && isDefined(settings.data) && (
          <aside
            className={styles.sidebar}
            data-collapsed={isSidebarCollapsed}
            aria-label="Разделы и представления"
          >
            <Tooltip label={sidebarToggleLabel} position="right" withArrow>
              <ActionIcon
                className={styles.sidebarToggle}
                variant="subtle"
                color="gray"
                size="lg"
                radius="xl"
                aria-label={sidebarToggleLabel}
                aria-expanded={!isSidebarCollapsed}
                aria-controls={sidebarNavigationId}
                onClick={() => setSidebarCollapsed(!isSidebarCollapsed)}
              >
                <SidebarToggleIcon size={18} aria-hidden="true" />
              </ActionIcon>
            </Tooltip>
            <div id={sidebarNavigationId} hidden={isSidebarCollapsed}>
              <LibraryNavigation
                settings={settings.data}
                selected={selected}
                counts={counts}
                countScope={countScope}
                onSelect={handleSelect}
              />
            </div>
          </aside>
        )}
        <div className={styles.main}>
          {isMedium && (
            <LibraryFilters
              {...filterProps}
              id={filtersPanelId}
              className={styles.filters}
              hidden={!isFilterPanelOpen}
            />
          )}
          {shouldShowScope && (
            <SearchScope
              query={requested.q.trim()}
              scopeParts={scopeParts}
              isNarrow={isNarrow}
              onSearchEverywhere={handleSearchEverywhere}
              onReset={handleReset}
            />
          )}
          {isDefined(settings.error) && (
            <LibraryNotice
              tone="warning"
              title="Не удалось прочитать разделы"
              message={settings.error.message}
              action={
                <Button
                  size="xs"
                  variant="default"
                  radius="xl"
                  onClick={() => void settings.mutate()}
                >
                  Повторить чтение
                </Button>
              }
            />
          )}
          {isDefined(catalogError) && (
            <LibraryNotice
              tone="warning"
              title={errorTitle}
              message={errorMessage}
              action={retryButton}
            />
          )}
          {isDefined(bulk.outcome) && (
            <BulkResult
              outcome={bulk.outcome}
              isRefreshing={catalog.isValidating}
              onRefresh={refreshAfterWrite}
              onDismiss={bulk.dismissOutcome}
            />
          )}
          {isDefined(actions.notice) && (
            <LibraryNotice
              tone={actions.notice.tone}
              title={actions.notice.title}
              message={actions.notice.message}
              action={actionNoticeRetry}
              onDismiss={actions.dismissNotice}
            />
          )}
          <MaterialList
            title={areaTitle}
            total={firstPage?.total ?? null}
            items={materialItems}
            sections={sections}
            query={filters.q}
            sort={sort}
            isSortFixed={isSortFixed}
            getHref={(id) => `${base}/documents/${id}`}
            returnTo={returnTo}
            busyIds={actions.busyIds}
            selectedIds={new Set(bulk.selected.keys())}
            onSelect={(materials, isSelected) =>
              bulk.toggle(
                materials.map((material) => ({
                  id: material.ref.id,
                  revision: material.revision,
                  title: material.title,
                  tags: material.document.tags,
                })),
                isSelected,
              )
            }
            hasMore={hasMore}
            isLoadingMore={isLoadingMore}
            state={resultState}
            onSortChange={(value) => updateParams({ sort: value === "updated" ? null : value })}
            onLoadMore={volume.loadMore}
            onOpen={rememberMaterial}
            onPreview={handlePreview}
            onChange={(material, changes) =>
              void actions.change(
                { id: material.ref.id, revision: material.revision, title: material.title },
                changes,
              )
            }
          />
          {hasSelection && (
            <BulkActions
              projectId={projectId}
              count={bulk.selected.size}
              isOverLimit={bulk.selected.size > BULK_LIMIT}
              isRunning={bulk.isRunning}
              sections={sections}
              selectedTags={selectedTags}
              onRun={(operation, action) => void bulk.run(operation, action)}
              onClear={bulk.clear}
            />
          )}
        </div>
      </div>
      <Drawer
        opened={!isWide && isNavigationOpen}
        position="left"
        size="20rem"
        title="Разделы и представления"
        closeButtonProps={{ "aria-label": "Закрыть разделы" }}
        classNames={{ content: styles.drawer, header: styles.drawer }}
        onClose={() => setNavigationOpen(false)}
      >
        {isDefined(settings.data) && (
          <LibraryNavigation
            settings={settings.data}
            selected={selected}
            counts={counts}
            countScope={countScope}
            onSelect={handleSelect}
          />
        )}
      </Drawer>
      <Drawer
        opened={!isMedium && isFiltersOpen}
        position="bottom"
        size="85%"
        title="Фильтры"
        closeButtonProps={{ "aria-label": "Закрыть фильтры" }}
        classNames={{ content: styles.drawer, header: styles.drawer }}
        onClose={() => setFiltersOpen(false)}
      >
        <LibraryFilters {...filterProps} />
        <Button fullWidth radius="xl" mt="lg" onClick={() => setFiltersOpen(false)}>
          Показать материалы
        </Button>
      </Drawer>
      <MaterialPreview
        material={preview}
        opened={isPreviewOpen}
        href={`${base}/documents/${preview?.id ?? ""}`}
        returnTo={returnTo}
        onClose={() => setPreviewOpen(false)}
      />
    </PageStage>
  );
};
