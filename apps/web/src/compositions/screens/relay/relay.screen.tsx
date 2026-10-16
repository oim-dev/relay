import { useEffect, useState } from "react";
import { Outlet, useLocation, useMatch, useNavigate } from "react-router-dom";
import { Badge, Button, Group, Select, Text } from "@mantine/core";
import { Layers3 } from "lucide-react";
import { useWorkspace } from "domains/workspace";
import { ProjectScope } from "domains/project";
import { StatePanel } from "ui/state-panel";
import { MarkdownLinkProvider } from "ui/markdown-link";
import { PageBreadcrumbs } from "compositions/widgets/page-breadcrumbs";
import { RelayMarkdownLink } from "./ui/relay-markdown-link/relay-markdown-link";
import styles from "./styles/relay.module.css";

/**
 * Открывает один проект или связывает workspace с выбором проекта в URL.
 *
 * Используется для:
 *  - переключения независимых досок и восстановления прямых ссылок
 */
export const RelayScreen = () => {
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const match = useMatch("/projects/:project/*");
  const selectedId = match?.params.project;
  const workspaceData = workspace.data;
  const projectItems = workspaceData?.projects ?? [];
  const [previousSelection, setPreviousSelection] = useState<{ reference: string; id: string }>();
  const directProject =
    projectItems.find((project) => project.id === selectedId) ??
    projectItems.find((project) => project.slug === selectedId) ??
    projectItems.find((project) => project.key === selectedId);
  const projectData =
    directProject ??
    projectItems.find(
      (project) =>
        previousSelection?.reference === selectedId && previousSelection?.id === project.id,
    );
  const canonicalAddress = projectData?.slug ?? projectData?.id;
  const resolvedId = projectData?.id;
  useEffect(() => {
    if (resolvedId === undefined || selectedId === undefined || canonicalAddress === undefined)
      return;
    setPreviousSelection({ reference: selectedId, id: resolvedId });
    if (selectedId === canonicalAddress) return;
    const suffix = location.pathname.replace(/^\/projects\/[^/]+/, "");
    navigate(
      `/projects/${encodeURIComponent(canonicalAddress)}${suffix}${location.search}${location.hash}`,
      {
        replace: true,
        state: location.state,
      },
    );
  }, [
    resolvedId,
    selectedId,
    canonicalAddress,
    location.pathname,
    location.search,
    location.hash,
    location.state,
    navigate,
  ]);
  const isWorkspace = workspaceData?.mode === "workspace";
  const canOpenProject = projectData !== undefined && projectData.available;
  const selectItems = [
    ...new Map(
      projectItems.map((project) => [
        project.id,
        {
          value: project.slug ?? project.id,
          label: project.name,
          disabled: !project.available,
        },
      ]),
    ).values(),
  ];
  const defaultProject = workspaceData?.defaultProject;
  useEffect(() => {
    if (workspaceData?.mode === "local" && defaultProject && selectedId === undefined) {
      navigate(
        `/projects/${encodeURIComponent(defaultProject)}${location.pathname}${location.search}${location.hash}`,
        { replace: true, state: location.state },
      );
    }
  }, [
    workspaceData?.mode,
    defaultProject,
    selectedId,
    navigate,
    location.pathname,
    location.search,
    location.hash,
    location.state,
  ]);

  if (workspaceData === undefined) {
    const isConnecting = workspace.isLoading;
    return (
      <main className={styles.content}>
        <PageBreadcrumbs
          items={[
            { id: "relay", label: "Relay", href: "/" },
            { id: "connection", label: "Подключение" },
          ]}
        />
        {isConnecting && (
          <StatePanel
            state="loading"
            titleAs="h1"
            title="Подключаемся к Relay"
            description="Читаем список проектов на сервере."
          />
        )}
        {!isConnecting && (
          <StatePanel
            state="error"
            titleAs="h1"
            title="Нет подключения к Relay"
            description="Запустите relay-server и проверьте подключение."
            action={
              <Button loading={workspace.isValidating} onClick={() => void workspace.mutate()}>
                Повторить
              </Button>
            }
          />
        )}
      </main>
    );
  }

  const stateTitle = selectedId === undefined ? "Выберите проект" : "Проект недоступен";
  const stateDescription =
    projectData?.error ??
    "Проекты добавляются в relay.workspace.json или через relay-cli projects add.";
  return (
    <div className={styles.root}>
      {isWorkspace && !canOpenProject && (
        <Group
          component="nav"
          aria-label="Проекты Relay"
          className={styles.selector}
          justify="space-between"
          gap="sm"
        >
          <Group gap="sm" wrap="nowrap">
            <Layers3 size={22} className={styles.brandIcon} aria-hidden="true" />
            <Text fw={750} className={styles.brand}>
              Relay
            </Text>
            <Badge variant="light" color="gray">
              workspace
            </Badge>
          </Group>
          <Select
            className={styles.projectSelect}
            comboboxProps={{ width: 288, position: "bottom-end" }}
            aria-label="Выбрать проект"
            placeholder="Выберите проект"
            data={selectItems}
            value={selectedId ?? null}
            searchable
            allowDeselect={false}
            onChange={(projectId) => {
              if (projectId !== null) navigate(`/projects/${encodeURIComponent(projectId)}/`);
            }}
          />
        </Group>
      )}
      {canOpenProject && (
        <ProjectScope key={projectData.id} projectId={projectData.id} slug={projectData.slug}>
          <MarkdownLinkProvider component={RelayMarkdownLink}>
            <Outlet />
          </MarkdownLinkProvider>
        </ProjectScope>
      )}
      {!canOpenProject && (
        <main className={styles.content}>
          <PageBreadcrumbs
            items={[
              { id: "relay", label: "Relay", href: "/" },
              { id: "selection", label: stateTitle },
            ]}
          />
          <StatePanel titleAs="h1" title={stateTitle} description={stateDescription} />
        </main>
      )}
    </div>
  );
};
