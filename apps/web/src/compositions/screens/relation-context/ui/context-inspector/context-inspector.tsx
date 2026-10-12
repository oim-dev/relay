import { Link, useLocation } from "react-router-dom";
import {
  Alert,
  Anchor,
  Button,
  Divider,
  Group,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { ArrowUpRight, GitFork, Route } from "lucide-react";
import {
  getEntityPresentation,
  getEntityStatusLabel,
  getEntityStatusTone,
  useEntityContent,
  ENTITY_PRESENTATION,
} from "domains/entities";
import { getRelationLabel, relationAddress } from "domains/relations";
import { useProjectBasePath } from "domains/project";
import { MarkdownView } from "ui/markdown-view";
import { StatusBadge } from "ui/status-badge";
import { isDefined } from "shared/value-predicates";
import { getContextEntityHref } from "../../helpers/get-context-entity-href";
import { ContextNodeRelations } from "./ui/context-node-relations/context-node-relations";
import type { ContextInspectorProps } from "./types/context-inspector-props.type";
import styles from "./styles/context-inspector.module.css";

/**
 * Объясняет выбранную сущность или сохранённое отношение.
 *
 * Используется для:
 *  - чтения полного Markdown и перехода на предметную страницу
 *  - раскрытия окружения и объясняющего пути
 */
export const ContextInspector = ({
  projectId,
  node,
  edge,
  nodes,
  edges,
  isRoot,
  canExpand,
  hasPath,
  isBusy,
  onExpand,
  onRoot,
  onPath,
  onNodeSelect,
  onEdgeSelect,
}: ContextInspectorProps) => {
  const base = useProjectBasePath();
  const location = useLocation();
  const address = node ? relationAddress(node.ref) : null;
  const isKnownKind = isDefined(node) && Object.hasOwn(ENTITY_PRESENTATION, node.ref.kind);
  const content = useEntityContent(projectId, isKnownKind ? address : null);
  const href = node ? getContextEntityHref(base, node, content.data?.boardSlug) : null;
  const hasHref = isDefined(href);
  const returnTo = `${location.pathname}${location.search}`;

  if (isDefined(edge)) {
    const from = relationAddress(edge.from);
    const to = relationAddress(edge.to);
    const fromNode = nodes.find((entry) => relationAddress(entry.ref) === from);
    const toNode = nodes.find((entry) => relationAddress(entry.ref) === to);
    const hasDescription = edge.description.trim() !== "";
    const createdAt = new Date(edge.createdAt).toLocaleString("ru-RU");
    return (
      <section className={styles.root} aria-label="Сведения о связи">
        <Text size="xs" c="dimmed" fw={600}>
          Сохранённая связь
        </Text>
        <Title order={2} size="h4">
          {getRelationLabel(edge.type)}
        </Title>
        <Stack gap="xs" className={styles.endpoints}>
          <Text size="xs" c="dimmed">
            Откуда
          </Text>
          <Anchor component="button" ta="left" onClick={() => onNodeSelect(from)}>
            {fromNode?.key ?? from} · {fromNode?.title}
          </Anchor>
          <Text size="xs" c="dimmed">
            Куда →
          </Text>
          <Anchor component="button" ta="left" onClick={() => onNodeSelect(to)}>
            {toNode?.key ?? to} · {toNode?.title}
          </Anchor>
        </Stack>
        {hasDescription && <MarkdownView text={edge.description} compact />}
        <Divider />
        <dl className={styles.metadata}>
          <dt>Тип</dt>
          <dd>{edge.type}</dd>
          <dt>Автор</dt>
          <dd>{edge.createdBy}</dd>
          <dt>Создана</dt>
          <dd>{createdAt}</dd>
          <dt>ID</dt>
          <dd>{edge.id}</dd>
          <dt>Ревизия</dt>
          <dd>{edge.revision}</dd>
        </dl>
        <Text size="xs" c="dimmed">
          Направление соответствует записи Core. Достижимость не означает готовность или
          обязательность требований.
        </Text>
      </section>
    );
  }
  if (!isDefined(node) || address === null) {
    return (
      <div className={styles.root}>
        <Text size="sm" c="dimmed">
          Выберите сущность или линию связи.
        </Text>
      </div>
    );
  }
  const presentation = getEntityPresentation(node.ref.kind);
  const canChangeRoot = !isRoot;
  const hasContentError = isDefined(content.error);
  const hasMarkdown = isDefined(content.data) && content.data.markdown.trim() !== "";
  const hasNoMarkdown = isDefined(content.data) && !hasMarkdown;
  const hasStatus = node.status !== "";
  const statusLabel = getEntityStatusLabel(node.status);
  const statusTone = getEntityStatusTone(node.status);
  return (
    <section className={styles.root} aria-label="Сведения о сущности">
      <Group gap="xs">
        <ThemeIcon color="accent" variant="light">
          <presentation.icon size={18} aria-hidden="true" />
        </ThemeIcon>
        <Text size="xs" c="dimmed">
          {presentation.label}
        </Text>
        {isRoot && <span className={styles.origin}>Исходная</span>}
      </Group>
      <div>
        <Text size="xs" c="dimmed">
          {node.key}
        </Text>
        <Title order={2} size="h4" mt={5}>
          {node.title || "Без названия"}
        </Title>
      </div>
      {hasStatus && (
        <p className={styles.status}>
          Состояние: <StatusBadge tone={statusTone}>{statusLabel}</StatusBadge>
        </p>
      )}
      <Stack gap="xs">
        <Button
          variant="light"
          color="accent"
          leftSection={<GitFork size={16} aria-hidden="true" />}
          disabled={!canExpand || isBusy}
          onClick={onExpand}
        >
          Раскрыть связи
        </Button>
        {canChangeRoot && (
          <Button variant="default" onClick={() => onRoot(address)}>
            Сделать исходной
          </Button>
        )}
        {canChangeRoot && (
          <Button
            variant="subtle"
            color="gray"
            leftSection={<Route size={16} aria-hidden="true" />}
            disabled={!hasPath}
            onClick={onPath}
          >
            Показать путь
          </Button>
        )}
        {hasHref && (
          <Button
            component={Link}
            to={href ?? ""}
            state={{ returnTo }}
            variant="subtle"
            color="gray"
            rightSection={<ArrowUpRight size={16} aria-hidden="true" />}
          >
            Открыть сущность
          </Button>
        )}
      </Stack>
      <ContextNodeRelations
        key={address}
        address={address}
        nodes={nodes}
        edges={edges}
        onSelect={onEdgeSelect}
      />
      <Divider label="Полное описание" labelPosition="left" />
      {content.isLoading && (
        <Group gap="xs" role="status">
          <Loader size="xs" />
          <Text size="sm">Загружаем описание…</Text>
        </Group>
      )}
      {hasContentError && (
        <Alert color="danger" title="Описание недоступно">
          {content.error?.message}
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            mt="xs"
            onClick={() => void content.mutate().catch(() => undefined)}
          >
            Повторить загрузку описания
          </Button>
        </Alert>
      )}
      {hasMarkdown && <MarkdownView text={content.data?.markdown ?? ""} compact />}
      {hasNoMarkdown && (
        <Text size="sm" c="dimmed">
          Описание не заполнено.
        </Text>
      )}
      <Text size="xs" c="dimmed">
        {address} · ревизия {node.revision}
      </Text>
    </section>
  );
};
