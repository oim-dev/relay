import { useEffect, useRef, useState } from "react";
import { Link, useParams, useLocation, useNavigate } from "react-router-dom";
import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Drawer,
  Menu,
  Popover,
  Stack,
  TextInput,
} from "@mantine/core";
import { useDebouncedValue, useHotkeys, useMediaQuery } from "@mantine/hooks";
import {
  BookOpen,
  Plus,
  Search,
  SlidersHorizontal,
  MoreHorizontal,
  ExternalLink,
} from "lucide-react";
import { useBoard } from "domains/boards";
import {
  BoardTaskError,
  BoardTaskNotFoundError,
  useBoardTask,
  useBoardTaskCreation,
} from "domains/board-tasks";
import type { TaskColumn, TaskFilters } from "domains/board-tasks";
import { useProjectId, useProjectBasePath } from "domains/project";
import { PageHeader } from "ui/page-header";
import { PageStage } from "ui/page-stage";
import { StatePanel } from "ui/state-panel";
import { EntityDocuments } from "compositions/widgets/entity-documents";
import { TaskKanban } from "./ui/task-kanban";
import { TaskModal } from "./ui/task-modal";
import { BOARD_BACKGROUND_SCHEMA } from "./config/route.schema";
import styles from "./styles/project-board.module.css";

/**
 * Показывает самостоятельную доску проекта по её slug.
 *
 * Используется для:
 *  - чтения назначения продуктовой, инфраструктурной или прикладной доски
 *  - канбана, поиска, междосочных связей и центрального редактора задачи
 */
export const ProjectBoardScreen = () => {
  const { boardSlug: routeBoard, id: taskReference, taskId: routeTask } = useParams();
  const id = routeTask ?? taskReference;
  const projectId = useProjectId();
  const location = useLocation();
  const navigate = useNavigate();
  const selected = id ?? null;
  const background = BOARD_BACKGROUND_SCHEMA.safeParse(location.state);
  const backgroundData = background.success ? background.data : undefined;
  const opened = useBoardTask(projectId, selected, backgroundData?.edit !== true);
  const boardSlug =
    selected !== null && backgroundData?.boardSlug !== undefined
      ? backgroundData.boardSlug
      : (routeBoard ?? opened.data?.boardSlug ?? (selected === null ? "product" : ""));
  const query = useBoard(projectId, boardSlug);
  const params = new URLSearchParams(
    location.search || (selected !== null ? (backgroundData?.search ?? "") : ""),
  );
  const base = useProjectBasePath();
  const [creatingColumn, setCreatingColumn] = useState<TaskColumn | null>(null);
  const [error, setError] = useState("");
  const [defect, setDefect] = useState<unknown>();
  const [isMaterialsOpened, setMaterialsOpened] = useState(false);
  const [isMaterialsDialogOpened, setMaterialsDialogOpened] = useState(false);
  const materialsButtonRef = useRef<HTMLButtonElement>(null);
  const isWideScreen = useMediaQuery("(min-width: 48em)");
  const materialsDrawerSize = isWideScreen ? "36rem" : "100%";
  const create = useBoardTaskCreation(projectId);
  const requestRef = useRef<{ board: string; column: TaskColumn; id: string } | null>(null);
  const isCreatingRef = useRef(false);
  const search = params.get("q") ?? "";
  /*
   * Поле поиска хранит ввод локально: адрес обновляется навигацией позже нажатий, и
   * управляемое из адреса поле теряло символы быстрого ввода. Адрес остаётся источником
   * для внешних изменений (Back/Forward, переход по ссылке), собственные записи пропускаются.
   */
  const [searchDraft, setSearchDraft] = useState(search);
  const writtenSearches = useRef<string[]>([]);
  const [debouncedSearch] = useDebouncedValue(search, 200);
  const isBlockedOnly = params.get("blocked") === "1";
  const showCancelled = params.get("cancelled") === "1";
  const filters: TaskFilters = {
    board: boardSlug,
    q: debouncedSearch,
    ...(isBlockedOnly ? { readiness: "blocked" } : {}),
  };
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const openedTaskRef = useRef<string | null>(null);
  const hadTaskRef = useRef(false);
  const handleOpen = (taskId: string, targetBoard = boardSlug, edit = false): void => {
    if (selected === null && document.activeElement instanceof HTMLElement)
      openerRef.current = document.activeElement;
    const filterSearch = params.size === 0 ? "" : `?${params.toString()}`;
    navigate(
      `${base}/boards/${encodeURIComponent(targetBoard)}/${encodeURIComponent(taskId)}${filterSearch}`,
      {
        replace: selected !== null,
        state: {
          boardSlug,
          search: params.toString(),
          edit,
          canGoBack: selected === null || backgroundData?.canGoBack === true,
        },
      },
    );
  };
  const handleCreate = async (target: TaskColumn): Promise<void> => {
    if (isCreatingRef.current) return;
    isCreatingRef.current = true;
    setCreatingColumn(target);
    setError("");
    if (requestRef.current?.board !== boardSlug || requestRef.current.column !== target)
      requestRef.current = { board: boardSlug, column: target, id: crypto.randomUUID() };
    try {
      const task = await create({
        board: boardSlug,
        column: target,
        requestId: requestRef.current.id,
      });
      requestRef.current = null;
      handleOpen(task.id, task.boardSlug, true);
    } catch (failure) {
      if (failure instanceof BoardTaskError) setError(failure.message);
      else setDefect(failure);
    } finally {
      isCreatingRef.current = false;
      setCreatingColumn(null);
    }
  };
  const handleClose = (): void => {
    if (backgroundData?.canGoBack === true) navigate(-1);
    else
      navigate(
        `${base}/boards/${opened.data?.boardSlug ?? (boardSlug || "product")}${location.search}${location.hash}`,
        {
          replace: true,
        },
      );
  };
  useEffect(() => {
    const index = writtenSearches.current.indexOf(search);
    if (index >= 0) {
      writtenSearches.current = writtenSearches.current.slice(index + 1);
      return;
    }
    writtenSearches.current = [];
    setSearchDraft(search);
  }, [search]);
  const handleSearch = (value: string): void => {
    setSearchDraft(value);
    writtenSearches.current.push(value);
    handleFilter("q", value);
  };
  const handleFilter = (name: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    navigate(
      { pathname: `${base}/boards/${boardSlug}`, search: next.toString() },
      { replace: true },
    );
  };
  useHotkeys([
    [
      "n",
      () => {
        if (selected === null) void handleCreate("inbox");
      },
    ],
  ]);
  useEffect(() => {
    if (selected !== null) {
      hadTaskRef.current = true;
      openedTaskRef.current = opened.data?.id ?? openedTaskRef.current;
      return;
    }
    // Окно задачи снимается вместе с маршрутом, поэтому фокус возвращает экран:
    // к вызвавшему элементу, иначе к карточке закрытой задачи, иначе к заголовку доски
    // (так и после окна отсутствующей задачи, открытой прямым адресом).
    const opener = openerRef.current;
    const taskId = openedTaskRef.current;
    const hadTask = hadTaskRef.current;
    openerRef.current = null;
    openedTaskRef.current = null;
    hadTaskRef.current = false;
    if (!hadTask) return;
    const card =
      taskId === null
        ? null
        : document.querySelector<HTMLElement>(
            `[data-task-id="${CSS.escape(taskId)}"] [data-open-task]`,
          );
    const target = opener?.isConnected === true ? opener : (card ?? headingRef.current);
    target?.focus({ preventScroll: true });
  }, [selected, opened.data?.id]);
  const legacyTask = new URLSearchParams(location.search).get("task");
  useEffect(() => {
    if (!routeBoard || !legacyTask || legacyTask === "new") return;
    const search = new URLSearchParams(location.search);
    search.delete("task");
    search.delete("column");
    const filterSearch = search.size === 0 ? "" : `?${search.toString()}`;
    navigate(
      `${base}/boards/${encodeURIComponent(routeBoard)}/${encodeURIComponent(legacyTask)}${filterSearch}${location.hash}`,
      {
        replace: true,
        state: { boardSlug: routeBoard, search: search.toString() },
      },
    );
  }, [routeBoard, legacyTask, location.search, location.hash, navigate, base]);
  useEffect(() => {
    if (selected !== null || routeBoard !== undefined) return;
    navigate(`${base}/boards/product${location.search}${location.hash}`, {
      replace: true,
      state: location.state,
    });
  }, [selected, routeBoard, base, location.search, location.hash, location.state, navigate]);
  useEffect(() => {
    if (selected === null || opened.data === undefined) return;
    const canonical = `${base}/boards/${encodeURIComponent(opened.data.boardSlug)}/${encodeURIComponent(opened.data.id)}`;
    if (location.pathname !== canonical)
      navigate(`${canonical}${location.search}${location.hash}`, {
        replace: true,
        state: location.state,
      });
  }, [
    selected,
    opened.data,
    base,
    location.pathname,
    location.search,
    location.hash,
    location.state,
    navigate,
  ]);
  const board = query.data;
  const hasError = error !== "";
  const filterCount = Number(isBlockedOnly) + Number(showCancelled);
  const filterLabel = filterCount > 0 ? `Фильтры · ${filterCount}` : "Фильтры";
  const isTaskMissing = opened.error instanceof BoardTaskNotFoundError;
  const taskErrorState = isTaskMissing ? "empty" : "error";
  const taskErrorTitle = isTaskMissing ? "Задача не найдена" : "Задача недоступна";
  const taskErrorDescription = isTaskMissing
    ? "В проекте нет задачи с таким адресом: её удалили или адрес неверен."
    : (opened.error?.message ?? "");
  if (defect !== undefined) throw defect;
  if (opened.error !== undefined && board === undefined)
    return (
      <PageStage layout="workspace" className={styles.stage}>
        <StatePanel
          state={taskErrorState}
          titleAs="h1"
          title={taskErrorTitle}
          description={taskErrorDescription}
          action={
            <Button component={Link} to={`${base}/boards/product`} variant="default">
              К доске
            </Button>
          }
        />
      </PageStage>
    );
  if (query.error !== undefined)
    return (
      <PageStage layout="workspace" className={styles.stage}>
        <StatePanel
          state="error"
          titleAs="h1"
          title="Не удалось открыть доску"
          description={query.error.message}
          action={
            <Button variant="default" onClick={() => void query.mutate().catch(() => undefined)}>
              Повторить
            </Button>
          }
        />
      </PageStage>
    );
  if (board === undefined)
    return (
      <PageStage layout="workspace" className={styles.stage}>
        <StatePanel
          state="loading"
          titleAs="h1"
          title="Загружаем доску"
          description="Получаем колонки и задачи доски."
        />
      </PageStage>
    );
  const applicationPath = `${base}/product/applications/${board.applicationId ?? ""}`;
  const isApplication = board.kind === "application";
  const boardDescription = isApplication
    ? "Задачи реализации приложения"
    : board.kind === "product"
      ? "Возможности, сценарии и развитие продукта"
      : "Окружение, инструменты и надёжность проекта";
  const allVariant = isBlockedOnly ? "subtle" : "light";
  const allColor = isBlockedOnly ? "gray" : "accent";
  const blockedVariant = isBlockedOnly ? "light" : "subtle";
  const blockedColor = isBlockedOnly ? "accent" : "gray";
  const filterVariant = filterCount > 0 ? "light" : "subtle";
  const filterColor = filterCount > 0 ? "accent" : "gray";
  return (
    <PageStage layout="workspace" className={styles.stage}>
      <PageHeader
        meta={
          <>
            <span>Доска</span>
            <span className={styles.prefix}>{board.prefix}</span>
          </>
        }
        title={board.name}
        titleRef={headingRef}
        description={boardDescription}
        actionsLayout="inline"
        actions={
          <>
            <Button
              ref={materialsButtonRef}
              variant="default"
              leftSection={<BookOpen size={16} aria-hidden="true" />}
              aria-haspopup="dialog"
              onClick={() => setMaterialsOpened(true)}
            >
              Материалы
            </Button>
            <Button
              leftSection={<Plus size={16} aria-hidden="true" />}
              loading={creatingColumn !== null}
              onClick={() => void handleCreate("inbox")}
            >
              Создать задачу
            </Button>
          </>
        }
      />
      <div className={styles.filters} role="search" aria-label="Поиск и фильтры доски">
        <TextInput
          type="search"
          aria-label="Поиск задач на доске"
          placeholder="Поиск задач…"
          leftSection={<Search size={16} aria-hidden="true" />}
          value={searchDraft}
          onChange={(event) => handleSearch(event.currentTarget.value)}
          className={styles.search}
        />
        <div className={styles.toggles}>
          <Button
            variant={allVariant}
            color={allColor}
            onClick={() => handleFilter("blocked", "")}
            aria-pressed={!isBlockedOnly}
          >
            Все задачи
          </Button>
          <Button
            variant={blockedVariant}
            color={blockedColor}
            onClick={() => handleFilter("blocked", isBlockedOnly ? "" : "1")}
            aria-pressed={isBlockedOnly}
          >
            С блокерами
          </Button>
          <Popover position="bottom-end" withArrow>
            <Popover.Target>
              <Button
                variant={filterVariant}
                color={filterColor}
                leftSection={<SlidersHorizontal size={16} aria-hidden="true" />}
              >
                {filterLabel}
              </Button>
            </Popover.Target>
            <Popover.Dropdown>
              <Stack gap="md">
                <Checkbox
                  label="Только с блокерами"
                  checked={isBlockedOnly}
                  onChange={(event) =>
                    handleFilter("blocked", event.currentTarget.checked ? "1" : "")
                  }
                />
                <Checkbox
                  label="Показать отменённые"
                  checked={showCancelled}
                  onChange={(event) =>
                    handleFilter("cancelled", event.currentTarget.checked ? "1" : "")
                  }
                />
              </Stack>
            </Popover.Dropdown>
          </Popover>
          {isApplication && (
            <Menu position="bottom-end">
              <Menu.Target>
                <ActionIcon aria-label="Действия доски">
                  <MoreHorizontal size={18} aria-hidden="true" />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  component={Link}
                  to={applicationPath}
                  leftSection={<ExternalLink size={16} aria-hidden="true" />}
                >
                  Открыть приложение
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          )}
        </div>
      </div>
      {hasError && (
        <Alert color="danger" title="Не удалось создать задачу">
          {error}
        </Alert>
      )}
      <TaskKanban
        key={board.id}
        projectId={projectId}
        filters={filters}
        showCancelled={showCancelled}
        onOpen={handleOpen}
        onCreate={(target) => void handleCreate(target)}
      />
      <Drawer
        opened={isMaterialsOpened}
        position="right"
        size={materialsDrawerSize}
        title={`Материалы доски «${board.name}»`}
        closeButtonProps={{ "aria-label": "Закрыть материалы доски" }}
        trapFocus={!isMaterialsDialogOpened}
        closeOnEscape={!isMaterialsDialogOpened}
        closeOnClickOutside={!isMaterialsDialogOpened}
        returnFocus={false}
        onClose={() => setMaterialsOpened(false)}
        onExitTransitionEnd={() => materialsButtonRef.current?.focus()}
      >
        <EntityDocuments
          target={{ kind: "board", id: board.id }}
          targetTitle={board.name}
          onOpenedChange={setMaterialsDialogOpened}
        />
      </Drawer>
      {selected !== null && (
        <TaskModal
          projectId={projectId}
          reference={selected}
          startEditing={backgroundData?.edit ?? false}
          onClose={handleClose}
          onOpen={handleOpen}
        />
      )}
    </PageStage>
  );
};
