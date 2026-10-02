import { useEffect, useRef, useState } from "react";
import { Link, useParams, useLocation, useNavigate } from "react-router-dom";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Drawer,
  Group,
  Menu,
  Popover,
  Skeleton,
  Stack,
  Text,
  TextInput,
  Title,
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
import { BoardTaskError, useBoardTask, useBoardTaskCreation } from "domains/board-tasks";
import type { TaskColumn, TaskFilters } from "domains/board-tasks";
import { useProjectId, useProjectBasePath } from "domains/project";
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
  const [debouncedSearch] = useDebouncedValue(search, 200);
  const isBlockedOnly = params.get("blocked") === "1";
  const showCancelled = params.get("cancelled") === "1";
  const filters: TaskFilters = {
    board: boardSlug,
    q: debouncedSearch,
    ...(isBlockedOnly ? { readiness: "blocked" } : {}),
  };
  const handleOpen = (taskId: string, targetBoard = boardSlug, edit = false): void => {
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
  if (defect !== undefined) throw defect;
  if (opened.error !== undefined && board === undefined)
    return (
      <Alert color="red" m="md" title="Задача недоступна">
        {opened.error.message}
        <Button component={Link} to={`${base}/boards/product`} variant="subtle">
          К доске
        </Button>
      </Alert>
    );
  if (query.error !== undefined || board === undefined) {
    return (
      <section className={styles.root}>
        <Skeleton height={40} mb="md" />
        <Skeleton height={280} />
        {query.error !== undefined && (
          <Alert color="red" title="Не удалось открыть доску">
            {query.error.message}
            <Button onClick={() => void query.mutate().catch(() => undefined)}>Повторить</Button>
          </Alert>
        )}
      </section>
    );
  }
  const applicationPath = `${base}/product/applications/${board.applicationId ?? ""}`;
  const isApplication = board.kind === "application";
  const boardDescription = isApplication
    ? "Задачи реализации приложения"
    : board.kind === "product"
      ? "Возможности, сценарии и развитие продукта"
      : "Окружение, инструменты и надёжность проекта";
  const allVariant = isBlockedOnly ? "subtle" : "light";
  const blockedVariant = isBlockedOnly ? "light" : "subtle";
  const blockedColor = isBlockedOnly ? "red" : "gray";
  return (
    <section className={styles.root}>
      <header className={styles.toolbar}>
        <Stack gap={6} className={styles.heading}>
          <Group gap="sm" wrap="nowrap">
            <Title order={1} className={styles.title}>
              {board.name}
            </Title>
            <Badge color="gray" variant="light" size="sm" className={styles.prefix}>
              {board.prefix}
            </Badge>
          </Group>
          <Text size="sm" c="dimmed" className={styles.subtitle}>
            {boardDescription}
          </Text>
        </Stack>
        <Group gap="xs" className={styles.actions}>
          <Button
            ref={materialsButtonRef}
            size="sm"
            variant="default"
            leftSection={<BookOpen size={15} aria-hidden="true" />}
            aria-haspopup="dialog"
            onClick={() => setMaterialsOpened(true)}
          >
            Материалы
          </Button>
          <Button
            size="sm"
            leftSection={<Plus size={16} />}
            loading={creatingColumn !== null}
            onClick={() => void handleCreate("inbox")}
          >
            Создать задачу
          </Button>
        </Group>
      </header>
      <div className={styles.filterbar}>
        <Group gap="xs" className={styles.controls}>
          <TextInput
            aria-label="Поиск задач на доске"
            placeholder="Поиск задач…"
            size="sm"
            leftSection={<Search size={14} />}
            value={search}
            onChange={(event) => handleFilter("q", event.currentTarget.value)}
            className={styles.search}
          />
          <Button
            size="xs"
            variant={allVariant}
            color="gray"
            onClick={() => handleFilter("blocked", "")}
            aria-pressed={!isBlockedOnly}
          >
            Все задачи
          </Button>
          <Button
            size="xs"
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
                size="xs"
                variant="subtle"
                color="gray"
                leftSection={<SlidersHorizontal size={14} />}
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
                <ActionIcon variant="subtle" color="gray" aria-label="Действия доски">
                  <MoreHorizontal size={18} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  component={Link}
                  to={applicationPath}
                  leftSection={<ExternalLink size={14} />}
                >
                  Открыть приложение
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          )}
        </Group>
      </div>
      {hasError && (
        <Alert color="red" title="Не удалось создать задачу" mb="sm">
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
    </section>
  );
};
