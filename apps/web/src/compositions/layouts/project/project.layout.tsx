import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { ActionIcon, Drawer, Group, Select, Text, Tooltip } from "@mantine/core";
import { ClipboardList, Layers3, Menu, Moon, Settings, Sun } from "lucide-react";
import {
  useGetProject,
  useProjectId,
  useProjectBasePath,
  useProjectConnection,
} from "domains/project";
import { useWorkspace } from "domains/workspace";
import { useThemeColorScheme } from "ui/themes";
import { ProjectBreadcrumbs } from "compositions/widgets/page-breadcrumbs";
import { ConnectionStatus } from "./ui/connection-status/connection-status";
import { ProjectNavigation } from "./ui/project-navigation";
import styles from "./styles/project.module.css";

/**
 * Организует постоянную навигацию и рабочую область одного проекта.
 *
 * Используется для:
 *  - переходов между планированием, исполнением и сопровождением
 *  - выбора проекта без собственного продуктового состояния workspace
 */
export const ProjectLayout = () => {
  const projectId = useProjectId();
  const project = useGetProject();
  const workspace = useWorkspace();
  const connection = useProjectConnection();
  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const [isNavigationOpen, setNavigationOpen] = useState(false);
  const selectorRef = useRef<HTMLInputElement>(null);
  const hasPlacedFocusRef = useRef(false);
  const { computedColorScheme, setColorScheme } = useThemeColorScheme();
  const base = useProjectBasePath();
  const currentProject = workspace.data?.projects.find((item) => item.id === projectId);
  const projectName = currentProject?.name ?? project.data?.name ?? "Проект";
  const projectItems = [
    ...new Map(
      (workspace.data?.projects ?? []).map((item) => [
        item.id,
        {
          value: item.slug ?? item.id,
          label: item.name,
          disabled: !item.available,
        },
      ]),
    ).values(),
  ];
  const isWorkspace = workspace.data?.mode === "workspace";
  const isDark = computedColorScheme === "dark";
  const ThemeIcon = isDark ? Sun : Moon;
  const nextTheme = isDark ? "light" : "dark";
  const connectionState = connection.data?.state ?? "connecting";
  const themeLabel = isDark ? "Включить светлую тему" : "Включить тёмную тему";
  const isSettingsPage = location.pathname === `${base}/settings`;
  const settingsVariant = isSettingsPage ? "light" : "subtle";
  const settingsCurrent = isSettingsPage ? "page" : undefined;
  // Каркас монтируется заново при смене проекта: выбор в шапке или на стартовом экране
  // удаляет нажатый контрол, и фокус падает на body. После такого перехода фокус
  // возвращается к выбору проекта; при открытии по прямой ссылке (POP) не трогается.
  useEffect(() => {
    if (hasPlacedFocusRef.current || !isWorkspace) return;
    hasPlacedFocusRef.current = true;
    const isFocusLost = document.activeElement === null || document.activeElement === document.body;
    if (navigationType === "PUSH" && isFocusLost) selectorRef.current?.focus();
  }, [isWorkspace, navigationType]);
  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <Group gap="sm" wrap="nowrap" className={styles.identity}>
          <ActionIcon
            className={styles.menuToggle}
            variant="subtle"
            color="gray"
            aria-label="Открыть навигацию"
            aria-expanded={isNavigationOpen}
            aria-haspopup="dialog"
            onClick={() => setNavigationOpen(true)}
          >
            <Menu size={20} aria-hidden="true" />
          </ActionIcon>
          <Layers3 size={22} className={styles.brandIcon} aria-hidden="true" />
          <span className={styles.brand}>Relay</span>
          <span className={styles.divider} aria-hidden="true">
            /
          </span>
          {!isWorkspace && (
            <Text className={styles.projectName} fw={600} size="sm" lineClamp={1}>
              {projectName}
            </Text>
          )}
          {isWorkspace && (
            <Select
              ref={selectorRef}
              aria-label="Выбрать проект"
              title={projectName}
              data={projectItems}
              value={currentProject?.slug ?? projectId}
              allowDeselect={false}
              onChange={(id) => {
                if (id !== null) navigate(`/projects/${encodeURIComponent(id)}/`);
              }}
              className={styles.selector}
              classNames={{ input: styles.selectorInput }}
              comboboxProps={{ width: 320, position: "bottom-start" }}
            />
          )}
        </Group>
        <Group gap="sm" wrap="nowrap" className={styles.actions}>
          <ConnectionStatus state={connectionState} message={connection.data?.message} />
          <Tooltip label={themeLabel}>
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label={themeLabel}
              onClick={() => setColorScheme(nextTheme)}
            >
              <ThemeIcon size={18} aria-hidden="true" />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Настройки проекта">
            <ActionIcon
              component={Link}
              to={`${base}/settings`}
              variant={settingsVariant}
              color="gray"
              aria-label="Настройки проекта"
              aria-current={settingsCurrent}
            >
              <Settings size={18} aria-hidden="true" />
            </ActionIcon>
          </Tooltip>
        </Group>
      </header>
      <div className={styles.workspace}>
        <aside className={styles.sidebar}>
          <p className={styles.sectionLabel} aria-hidden="true">
            Проект
          </p>
          <ProjectNavigation basePath={base} />
          <div className={styles.sidebarFooter}>
            <ClipboardList size={16} aria-hidden="true" />
            <Text size="xs" c="dimmed">
              Общий контекст.
              <br />
              Осмысленный следующий шаг.
            </Text>
          </div>
        </aside>
        <main className={styles.content}>
          <ProjectBreadcrumbs />
          <Outlet />
        </main>
      </div>
      <Drawer
        opened={isNavigationOpen}
        onClose={() => setNavigationOpen(false)}
        position="left"
        size="min(20rem, calc(100vw - 2rem))"
        title="Разделы проекта"
        closeButtonProps={{ "aria-label": "Закрыть навигацию" }}
        classNames={{
          content: styles.drawer,
          header: styles.drawerHeader,
          title: styles.drawerTitle,
        }}
      >
        <ProjectNavigation basePath={base} onNavigate={() => setNavigationOpen(false)} />
      </Drawer>
    </div>
  );
};
