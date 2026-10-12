import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ActionIcon,
  Alert,
  Button,
  Modal,
  NumberInput,
  SegmentedControl,
  Skeleton,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import { ArrowLeft, GitFork, Plus, RefreshCw } from "lucide-react";
import { useProjectId, useProjectBasePath } from "domains/project";
import { useEntitySummary } from "domains/entities";
import { relationAddress, relationError, saveRelations, useRelations } from "domains/relations";
import { PageHeader } from "ui/page-header";
import { PageStage } from "ui/page-stage";
import { SectionPanel } from "ui/section-panel";
import { StatePanel } from "ui/state-panel";
import { EntityBrowser } from "./ui/entity-browser/entity-browser";
import { RelationEditor } from "./ui/relation-editor/relation-editor";
import { RelationExplorer } from "./ui/relation-explorer/relation-explorer";
import { getEntityPresentation } from "./config/relation-presentation";
import styles from "./styles/project-relations.module.css";

/**
 * Даёт человеку адресное рабочее место для исследования связей проекта.
 *
 * Используется для:
 *  - выбора сущности и последовательного восстановления её окружения
 *  - добавления недостающих отношений с сохранением контекста
 */
export const ProjectRelationsScreen = () => {
  const projectId = useProjectId();
  const base = useProjectBasePath();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [params, setParams] = useSearchParams();
  const root = params.get("root");
  const selection = useEntitySummary(projectId, root);
  const selectedNode = selection.data;
  const selectedAddress = selectedNode ? relationAddress(selectedNode.ref) : root;
  const mode = params.get("view") === "chain" ? "chain" : "direct";
  const depth = Math.trunc(Math.min(100, Math.max(2, Number(params.get("depth")) || 3)));
  const [page, setPage] = useState({
    scope: "",
    offset: 0,
    version: undefined as string | undefined,
  });
  const scope = `${root}:${mode}:${depth}`;
  const currentPage = page.scope === scope ? page : { offset: 0, version: undefined };
  const [isEditorOpen, setEditorOpen] = useState(false);
  const [editorData, setEditorData] = useState<{
    root: string;
    version: string;
    key: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const request = useRef({ signature: "", id: crypto.randomUUID() });
  const query = useRelations(
    projectId,
    root === null
      ? null
      : {
          root,
          depth: mode === "direct" ? 1 : depth,
          profile: "all",
          limit: 30,
          offset: currentPage.offset,
          version: currentPage.version,
        },
  );
  const graph = query.data;
  const version = graph?.version ?? "";
  const hasSelection = root !== null;
  const hasNoSelection = !hasSelection;
  const isChain = mode === "chain";
  const presentation = getEntityPresentation(selectedNode?.ref.kind ?? "project");
  const hasError = error !== null || query.error !== undefined || selection.error !== undefined;
  const errorMessage = error ?? query.error?.message ?? selection.error?.message;
  const canEdit = version !== "" && !hasError && selectedNode !== undefined;
  const hasGraph = graph !== undefined && selectedAddress !== null && !hasError;
  const hasEditor = editorData !== null;
  const hasBoundary = isChain && graph?.depthLimited === true;
  const isLoading = query.isLoading || selection.isLoading;
  const selectedTitle =
    selectedNode?.title ??
    (selection.error === undefined ? "Загружаем сущность…" : "Сущность недоступна");
  /**
   * Начинает новый снимок, сохраняя каталог и открытый черновик.
   */
  const handleRefresh = (): void => {
    setPage({ scope, offset: 0, version: undefined });
    setError(null);
    void query.mutate().catch(() => undefined);
    void selection.mutate().catch(() => undefined);
  };
  /**
   * Открывает соседа отдельным шагом истории браузера.
   */
  const handleSelect = (address: string | null): void => {
    setParams(address === null ? {} : { root: address });
    setError(null);
    setNotice("");
    titleRef.current?.scrollIntoView({ block: "start" });
  };
  /**
   * Сохраняет режим в URL, чтобы возврат восстанавливал область чтения.
   */
  const handleMode = (value: string): void => {
    const nextParams = new URLSearchParams(params);
    if (value === "chain") nextParams.set("view", "chain");
    else nextParams.delete("view");
    setParams(nextParams, { replace: true });
  };
  /**
   * Создаёт форму один раз; сворачивание не уничтожает введённые поля.
   */
  const handleCreate = (): void => {
    if (editorData === null && selectedAddress !== null) {
      setEditorData({ root: selectedAddress, version, key: crypto.randomUUID() });
    }
    setEditorOpen(true);
  };
  /**
   * Отзывает явно установленную связь с идемпотентным повтором.
   */
  const handleRemove = async (id: string): Promise<void> => {
    const signature = JSON.stringify([id, version]);
    if (request.current.signature !== signature)
      request.current = { signature, id: crypto.randomUUID() };
    try {
      await saveRelations(projectId, [{ action: "remove", id }], version, request.current.id);
      setNotice("Связь удалена. Сущности сохранены.");
      handleRefresh();
    } catch (failure) {
      setError(relationError(failure).message);
    }
  };
  /**
   * Возвращает к окружению после подтверждённой записи.
   */
  const handleSaved = (): void => {
    setEditorOpen(false);
    setEditorData(null);
    setNotice("Связь добавлена.");
    handleRefresh();
  };
  const createLabel = hasEditor ? "Продолжить диагностику" : "Диагностическое ребро";
  const visualizationHref = `${base}/relations/context?${new URLSearchParams({ root: selectedAddress ?? "" })}`;
  const canVisualize = selectedNode !== undefined;
  const kindMeta = (
    <span className={styles.kind}>
      <ThemeIcon variant="light" color="accent" size={28}>
        <presentation.icon size={16} aria-hidden="true" />
      </ThemeIcon>
      <span>
        {presentation.label} · {selectedNode?.key ?? root}
      </span>
    </span>
  );
  return (
    <PageStage className={styles.stage}>
      <PageHeader
        title="Связи проекта"
        titleRef={titleRef}
        description="Найдите сущность и проследите, как она связана с остальным проектом."
        actionsLayout="inline"
        actions={
          <Tooltip
            label="Обновить связи и выбранную сущность"
            events={{ hover: true, focus: true, touch: false }}
          >
            <ActionIcon
              variant="default"
              size="lg"
              aria-label="Обновить связи"
              disabled={!hasSelection}
              loading={query.isValidating}
              onClick={handleRefresh}
            >
              <RefreshCw size={16} aria-hidden="true" />
            </ActionIcon>
          </Tooltip>
        }
      />
      <div className={styles.workspace}>
        <aside className={styles.catalog} data-hidden={hasSelection}>
          <EntityBrowser projectId={projectId} selected={selectedAddress} onSelect={handleSelect} />
        </aside>
        <div className={styles.content}>
          {hasNoSelection && (
            <StatePanel
              className={styles.welcome}
              title="У каждой связи есть отправная точка"
              description="Выберите сущность в каталоге: найдите её по названию или ключу, затем исследуйте зависимости, состав, реализации и материалы и переходите к соседям."
            />
          )}
          {hasSelection && (
            <>
              <Button
                variant="subtle"
                color="gray"
                size="compact-sm"
                leftSection={<ArrowLeft size={15} aria-hidden="true" />}
                onClick={() => handleSelect(null)}
                className={styles.back}
              >
                К выбору сущности
              </Button>
              <SectionPanel
                tone="feature-header"
                title={selectedTitle}
                description={kindMeta}
                actions={
                  <>
                    {canVisualize && (
                      <Button
                        component={Link}
                        to={visualizationHref}
                        variant="light"
                        color="accent"
                        leftSection={<GitFork size={16} aria-hidden="true" />}
                      >
                        Смотреть визуализацию связей
                      </Button>
                    )}
                    <Button
                      leftSection={<Plus size={16} aria-hidden="true" />}
                      disabled={!canEdit && !hasEditor}
                      onClick={handleCreate}
                      variant="default"
                    >
                      {createLabel}
                    </Button>
                  </>
                }
              >
                <div className={styles.viewBar}>
                  <SegmentedControl
                    aria-label="Область связей"
                    size="sm"
                    value={mode}
                    onChange={handleMode}
                    data={[
                      { value: "direct", label: "Связи сущности" },
                      { value: "chain", label: "Цепочка связей" },
                    ]}
                  />
                  {isChain && (
                    <NumberInput
                      aria-label="Глубина цепочки"
                      prefix="Шагов: "
                      min={2}
                      max={100}
                      allowDecimal={false}
                      value={depth}
                      w={130}
                      onChange={(value) => {
                        const nextParams = new URLSearchParams(params);
                        nextParams.set("depth", String(value));
                        setParams(nextParams, { replace: true });
                      }}
                    />
                  )}
                </div>
                <p className={styles.notice} role="status">
                  {notice}
                </p>
                {hasError && (
                  <Alert color="danger" title="Не удалось получить актуальные связи" role="alert">
                    {errorMessage}
                    <Button variant="subtle" color="gray" mt="xs" onClick={handleRefresh}>
                      Повторить с начала
                    </Button>
                  </Alert>
                )}
                {isLoading && (
                  <div className={styles.loading} role="status" aria-label="Загрузка связей">
                    <Skeleton h={100} />
                    <Skeleton h={100} />
                  </div>
                )}
                {hasBoundary && (
                  <p className={styles.hint}>
                    Показана цепочка до {depth} шагов. Чтобы идти дальше, выберите соседнюю сущность
                    или увеличьте глубину.
                  </p>
                )}
                {hasGraph && (
                  <RelationExplorer
                    key={scope}
                    graph={graph}
                    root={selectedAddress}
                    isChain={isChain}
                    offset={currentPage.offset}
                    onSelect={handleSelect}
                    onRemove={handleRemove}
                    onPage={(offset) => setPage({ scope, offset, version })}
                  />
                )}
              </SectionPanel>
            </>
          )}
        </div>
      </div>
      <Modal.Root
        opened={isEditorOpen}
        onClose={() => setEditorOpen(false)}
        size="lg"
        centered
        keepMounted
      >
        <Modal.Overlay />
        <Modal.Content>
          <Modal.Header role="presentation">
            <Modal.Title>Добавить диагностическое ребро</Modal.Title>
            <Modal.CloseButton aria-label="Свернуть форму связи" />
          </Modal.Header>
          <Modal.Body>
            {hasEditor && (
              <RelationEditor
                key={editorData.key}
                projectId={projectId}
                version={editorData.version}
                root={editorData.root}
                onSaved={handleSaved}
                onCancel={() => setEditorOpen(false)}
              />
            )}
          </Modal.Body>
        </Modal.Content>
      </Modal.Root>
    </PageStage>
  );
};
