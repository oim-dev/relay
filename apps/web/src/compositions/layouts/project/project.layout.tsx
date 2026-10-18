import { useEffectEvent, useLayoutEffect, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  ActionIcon,
  Button,
  Code,
  CopyButton,
  Drawer,
  Group,
  Modal,
  Select,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
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
  const [isNavigationOpen, setNavigationOpen] = useState(false);
  const { colorScheme, setColorScheme } = useThemeColorScheme();
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
  const isDark = colorScheme === "dark";
  const ThemeIcon = isDark ? Sun : Moon;
  const nextTheme = isDark ? "light" : "dark";
  const state = connection.data?.state ?? "connecting";
  const connectionLabel = {
    connected: "Подключено к серверу",
    connecting: "Соединяемся",
    reconnecting: "Переподключаемся",
    disconnected: "Нет соединения",
    "storage-error": "Ошибка хранилища",
  }[state];
  const isSettingsPage = location.pathname === `${base}/settings`;
  const settingsVariant = isSettingsPage ? "light" : "subtle";
  const settingsCurrent = isSettingsPage ? "page" : undefined;
  const isBlocked = connection.data?.blocked ?? false;
  const syncAction = connection.data?.code === "SYNC_CONFLICT" ? "conflicts" : "status";
  const configArgument = project.data
    ? ` --local --config '${project.data.configPath.replaceAll("'", "'\\''")}'`
    : "";
  const syncCommand = `npx @oim-dev/relay-cli${configArgument} sync ${syncAction}`;
  const handleBlockedKey = useEffectEvent((event: KeyboardEvent) => {
    if (!isBlocked || event.key === "Tab") return;
    // Mantine слушает Escape в capture-фазе window: обработчик внутри dialog
    // вызывается слишком поздно и не защищает форму в нижнем модальном окне.
    event.stopImmediatePropagation();
    if (event.key === "Escape") event.preventDefault();
  });
  useLayoutEffect(() => {
    const listener = (event: KeyboardEvent) => handleBlockedKey(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);
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
          <Layers3 size={22} className={styles.brandIcon} />
          <span className={styles.brand}>Relay</span>
          <span className={styles.divider}>/</span>
          <Text
            className={styles.projectName}
            data-workspace={isWorkspace}
            fw={600}
            size="sm"
            lineClamp={1}
          >
            {projectName}
          </Text>
          {isWorkspace && (
            <Select
              aria-label="Выбрать проект"
              size="xs"
              data={projectItems}
              value={currentProject?.slug ?? projectId}
              allowDeselect={false}
              onChange={(id) => {
                if (id !== null) navigate(`/projects/${encodeURIComponent(id)}/`);
              }}
              className={styles.selector}
              comboboxProps={{ width: 260, position: "bottom-start" }}
            />
          )}
        </Group>
        <Group gap="sm" wrap="nowrap" className={styles.actions}>
          <Tooltip label={connectionLabel}>
            <span className={styles.connection} data-state={state} role="status">
              <span className={styles.dot} />
              <span className={styles.connectionText}>{connectionLabel}</span>
            </span>
          </Tooltip>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label="Переключить цветовую тему"
            onClick={() => setColorScheme(nextTheme)}
          >
            <ThemeIcon size={17} />
          </ActionIcon>
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
          <div className={styles.sectionLabel}>ПРОЕКТ</div>
          <ProjectNavigation basePath={base} />
          <div className={styles.sidebarFooter}>
            <ClipboardList size={16} />
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
        classNames={{ content: styles.drawer, header: styles.drawerHeader }}
      >
        <ProjectNavigation basePath={base} onNavigate={() => setNavigationOpen(false)} />
      </Drawer>
      <Modal.Root
        opened={isBlocked}
        onClose={() => {}}
        closeOnClickOutside={false}
        closeOnEscape={false}
        zIndex={1000}
        centered
      >
        <Modal.Overlay />
        <Modal.Content>
          <Modal.Header role="presentation">
            <Modal.Title>Работа с базой приостановлена</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Stack gap="md">
              <Text>{connection.data?.message}</Text>
              <Text size="sm">
                Выполните команду на стороне Server и разрешите конфликт. Открытая форма остаётся на
                странице; после разблокировки проверьте актуальные данные перед сохранением.
              </Text>
              <Code block className={styles.syncCommand}>
                {syncCommand}
              </Code>
              <CopyButton value={syncCommand}>
                {({ copied, copy }) => {
                  const label = copied ? "Команда скопирована" : "Скопировать команду";
                  return (
                    <Button data-autofocus onClick={copy}>
                      {label}
                    </Button>
                  );
                }}
              </CopyButton>
            </Stack>
          </Modal.Body>
        </Modal.Content>
      </Modal.Root>
    </div>
  );
};
