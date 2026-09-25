import clsx from "clsx";
import { Fragment, useId, useState } from "react";
import { Button, Divider, NavLink, Text } from "@mantine/core";
import { NavLink as RouterNavLink, useLocation } from "react-router-dom";
import { Box, ChartNoAxesCombined, LayoutDashboard } from "lucide-react";
import { useBoards } from "domains/boards";
import { useBoardTask } from "domains/board-tasks";
import { useProjectId } from "domains/project";
import {
  PRODUCT_NAVIGATION,
  PROJECT_NAVIGATION,
  PROJECT_RESOURCES_NAVIGATION,
} from "./config/navigation";
import type { ProjectNavigationProps } from "./types/project-navigation-props.type";
import styles from "./styles/project-navigation.module.css";

/** Публичные точки оформления ссылок Mantine. */
const LINK_CLASSES = { label: styles.label, section: styles.icon };

/**
 * Представляет разделы проекта и вложенную навигацию продукта.
 *
 * Используется для:
 *  - постоянного сайдбара и выдвижной навигации на узком экране
 *  - раскрытия продукта и выделения выбранного подраздела по URL
 */
export const ProjectNavigation = (props: ProjectNavigationProps) => {
  const { basePath, onNavigate, className, ...rootAttrs } = props;
  const { pathname } = useLocation();
  const projectId = useProjectId();
  const boards = useBoards(projectId);
  const boardsNavigationId = useId();
  const [isBoardsOpened, setBoardsOpened] = useState(false);
  const taskReference = pathname.startsWith(`${basePath}/tasks/`)
    ? pathname.split("/").at(-1)
    : undefined;
  const isKanbanTask = taskReference !== undefined && /[A-Za-z]/.test(taskReference);
  const openedTask = useBoardTask(projectId, isKanbanTask ? taskReference : null);
  const isBoardsRoute = pathname.startsWith(`${basePath}/boards/`) || isKanbanTask;
  const boardItems = boards.data?.flatMap((page) => page.items) ?? [];
  const boardNavigationItems = boardItems.map((board, index) => ({
    id: board.id,
    name: board.name,
    label: board.kind === "application" ? board.prefix : board.name,
    href: `${basePath}/boards/${board.slug}`,
    isActive: isKanbanTask && openedTask.data?.boardSlug === board.slug,
    hasSeparator: index > 0 && board.kind !== boardItems[index - 1]?.kind,
  }));
  const hasMoreBoards = boards.data?.at(-1)?.nextOffset != null;
  const hasBoardsError = boards.error !== undefined;
  const productNavigationId = useId();
  const [isProductOpened, setProductOpened] = useState(false);
  const productPath = `${basePath}/product`;
  const isProductRoute = pathname === productPath || pathname.startsWith(`${productPath}/`);
  const overviewPath = `${basePath}/`;
  const productItems = PRODUCT_NAVIGATION.map((entry) => ({
    ...entry,
    href: `${productPath}/${entry.path}`,
  }));
  const projectItems = [...PROJECT_NAVIGATION, ...PROJECT_RESOURCES_NAVIGATION].map((entry) => ({
    ...entry,
    href: `${basePath}/${entry.path}`,
    hasSeparator: entry.path === PROJECT_RESOURCES_NAVIGATION[0]?.path,
  }));

  return (
    <nav {...rootAttrs} className={clsx(styles.root, className)} aria-label="Разделы проекта">
      <NavLink
        component={RouterNavLink}
        to={overviewPath}
        end
        label="Обзор"
        leftSection={<ChartNoAxesCombined size={17} aria-hidden="true" />}
        className={styles.link}
        classNames={LINK_CLASSES}
        onClick={onNavigate}
      />
      <div className={styles.product}>
        <NavLink
          component="button"
          type="button"
          label="Продукт"
          leftSection={<Box size={17} aria-hidden="true" />}
          className={clsx(styles.link, isProductRoute && styles._currentGroup)}
          classNames={{ ...LINK_CLASSES, children: styles.children }}
          opened={isProductOpened}
          onChange={setProductOpened}
          childrenOffset={0}
          keepMounted={false}
          aria-expanded={isProductOpened}
          aria-controls={productNavigationId}
        >
          <div
            id={productNavigationId}
            className={styles.productLinks}
            role="group"
            aria-label="Продукт"
          >
            {productItems.map((entry) => (
              <NavLink
                key={entry.path}
                component={RouterNavLink}
                to={entry.href}
                label={entry.label}
                leftSection={<entry.Icon size={15} aria-hidden="true" />}
                className={clsx(styles.link, styles._child)}
                classNames={LINK_CLASSES}
                onClick={onNavigate}
              />
            ))}
          </div>
        </NavLink>
      </div>
      <NavLink
        component="button"
        type="button"
        label="Доски и задачи"
        leftSection={<LayoutDashboard size={17} aria-hidden="true" />}
        className={clsx(styles.link, isBoardsRoute && styles._currentGroup)}
        classNames={{ ...LINK_CLASSES, children: styles.children }}
        opened={isBoardsOpened}
        onChange={setBoardsOpened}
        childrenOffset={0}
        aria-expanded={isBoardsOpened}
        aria-controls={boardsNavigationId}
      >
        <div
          id={boardsNavigationId}
          className={styles.productLinks}
          role="group"
          aria-label="Доски и задачи"
        >
          {boards.isLoading && (
            <Text size="xs" c="dimmed" p="sm" role="status">
              Загружаем доски…
            </Text>
          )}
          {boardNavigationItems.map((board) => (
            <Fragment key={board.id}>
              {board.hasSeparator && (
                <Divider my="xs" mx="xs" color="var(--tasks-border)" aria-hidden="true" />
              )}
              <NavLink
                component={RouterNavLink}
                to={board.href}
                label={board.label}
                title={board.name}
                active={board.isActive}
                className={clsx(styles.link, styles._child)}
                classNames={LINK_CLASSES}
                onClick={onNavigate}
              />
            </Fragment>
          ))}
          {hasBoardsError && (
            <div role="alert">
              <Text size="xs" c="red" p="xs">
                Не удалось загрузить доски.
              </Text>
              <Button
                size="xs"
                variant="subtle"
                onClick={() =>
                  void boards
                    .setSize(1)
                    .then(() => boards.mutate())
                    .catch(() => undefined)
                }
              >
                Повторить
              </Button>
            </div>
          )}
          {hasMoreBoards && (
            <Button
              size="xs"
              variant="subtle"
              loading={boards.isValidating}
              onClick={() => void boards.setSize(boards.size + 1).catch(() => undefined)}
            >
              Показать ещё доски
            </Button>
          )}
        </div>
      </NavLink>
      {projectItems.map((entry) => (
        <Fragment key={entry.path}>
          {entry.hasSeparator && (
            <Divider my="xs" mx="xs" color="var(--tasks-border)" aria-hidden="true" />
          )}
          <NavLink
            component={RouterNavLink}
            to={entry.href}
            label={entry.label}
            leftSection={<entry.Icon size={17} aria-hidden="true" />}
            className={styles.link}
            classNames={LINK_CLASSES}
            onClick={onNavigate}
          />
        </Fragment>
      ))}
    </nav>
  );
};
