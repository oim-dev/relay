import { Alert, Button, Text } from "@mantine/core";
import { Link, Navigate, useLocation, useMatch, useNavigate, useParams } from "react-router-dom";
import { Network, Pencil } from "lucide-react";
import { useProjectId, useProjectBasePath } from "domains/project";
import {
  ProductKey,
  productEntityPath,
  productError,
  ProductNotFoundError,
  useProductEntities,
  useProductEntity,
  PRODUCT_STATUS_LABELS,
} from "domains/product";
import { ProductReadiness } from "domains/product-demo";
import { getProductReturn, ProductPage, useProductPath } from "compositions/widgets/product-page";
import { ProductRequirement } from "compositions/widgets/product-requirement";
import { EntityDelete } from "compositions/widgets/entity-delete";
import { EntityDocuments } from "compositions/widgets/entity-documents";
import { PageStage } from "ui/page-stage";
import { StatePanel } from "ui/state-panel";
import { ImplementationEditor } from "./ui/implementation-editor/implementation-editor";
import { ImplementationDetails } from "./ui/implementation-details/implementation-details";
import styles from "./styles/product-entity.module.css";

/**
 * Адресно открывает сценарий или реализацию, сохраняя контекст исходного требования.
 *
 * Используется для:
 *  - чтения одной записи без загрузки всего продукта и независимого редактирования вклада
 */
export const ProductEntityScreen = () => {
  const { entityRef, featureRef, applicationRef } = useParams();
  const projectId = useProjectId();
  const projectBase = useProjectBasePath();
  const base = useProductPath();
  const location = useLocation();
  const navigate = useNavigate();
  const editorMatch = useMatch(
    "/projects/:project/product/applications/:applicationRef/implementations/:entityRef/edit",
  );
  const legacyEditorMatch = useMatch("/projects/:project/product/implementations/:entityRef/edit");
  const isEditing = editorMatch !== null || legacyEditorMatch !== null;
  const query = useProductEntity(projectId, entityRef ?? null);
  const entity = query.data;
  const summary = useProductEntities(
    projectId,
    entity === undefined ? null : { refs: [entity.id] },
  );
  const meta = summary.data?.items.find((entry) => entry.id === entity?.id);
  const parentRefs =
    meta === undefined
      ? []
      : [meta.applicationId, meta.featureId, meta.scenarioId].filter(
          (id): id is string => id !== null,
        );
  const parents = useProductEntities(
    projectId,
    parentRefs.length === 0 ? null : { refs: parentRefs },
  );
  const parentItems = (parents.data?.items ?? []).map((entry) => ({
    ...entry,
    href: `${base}${productEntityPath(entry)}`,
    contextHref: `${base}${productEntityPath(entry)}${location.search}`,
  }));
  const isMissing = query.error instanceof ProductNotFoundError && entity === undefined;
  if (isMissing) {
    const isImplementationAddress = location.pathname.includes("/implementations/");
    const missingTitle = isImplementationAddress ? "Реализация не найдена" : "Сценарий не найден";
    const listHref = isImplementationAddress
      ? `${base}/applications${applicationRef === undefined ? "" : `/${applicationRef}`}`
      : `${base}/features${featureRef === undefined ? "" : `/${featureRef}`}`;
    const listLabel = isImplementationAddress
      ? applicationRef === undefined
        ? "К приложениям"
        : "К приложению"
      : featureRef === undefined
        ? "К списку фич"
        : "К фиче";
    return (
      <PageStage>
        <StatePanel
          titleAs="h1"
          title={missingTitle}
          description="В проекте нет записи с таким адресом: её удалили или адрес неверен."
          action={
            <Button component={Link} to={listHref} variant="default">
              {listLabel}
            </Button>
          }
        />
      </PageStage>
    );
  }
  if (query.error !== undefined && entity === undefined)
    return (
      <PageStage>
        <StatePanel
          titleAs="h1"
          state="error"
          title="Не удалось открыть запись"
          description={productError(query.error)}
          action={
            <Button variant="default" onClick={() => void query.mutate()}>
              Повторить
            </Button>
          }
        />
      </PageStage>
    );
  if (entity === undefined)
    return (
      <PageStage>
        <StatePanel
          titleAs="h1"
          state="loading"
          title="Открываем запись"
          description="Загружаем выбранное описание."
        />
      </PageStage>
    );
  const fields = entity.fields;
  if (fields.kind !== "scenario" && fields.kind !== "implementation")
    return (
      <PageStage>
        <StatePanel
          titleAs="h1"
          title="Неверный тип записи"
          description="Откройте запись из соответствующего раздела продукта."
        />
      </PageStage>
    );
  const isImplementation = fields.kind === "implementation";
  const expectedCollection = isImplementation ? "implementations" : "scenarios";
  if (!location.pathname.includes(`/${expectedCollection}/`))
    return (
      <PageStage>
        <StatePanel
          titleAs="h1"
          title="Неверный тип записи"
          description="Ключ не соответствует разделу адреса."
        />
      </PageStage>
    );
  const featureParent = parentItems.find((entry) => entry.kind === "feature");
  const applicationParent = parentItems.find((entry) => entry.kind === "application");
  const parent = isImplementation ? applicationParent : featureParent;
  const hasParentError = summary.error !== undefined || parents.error !== undefined;
  const parentTitle = hasParentError ? "Не удалось открыть контекст" : "Открываем запись";
  const parentState = hasParentError ? "error" : "loading";
  if (meta === undefined || parent === undefined)
    return (
      <PageStage>
        <StatePanel
          titleAs="h1"
          state={parentState}
          title={parentTitle}
          description="Уточняем родительскую запись."
          action={
            hasParentError && (
              <Button
                onClick={() => {
                  void summary.mutate();
                  void parents.mutate();
                }}
              >
                Повторить
              </Button>
            )
          }
        />
      </PageStage>
    );
  if (
    isImplementation &&
    applicationRef !== undefined &&
    applicationRef !== applicationParent?.id &&
    applicationRef !== applicationParent?.key
  )
    return (
      <PageStage>
        <StatePanel
          titleAs="h1"
          title="Реализация не принадлежит этому приложению"
          description="Проверьте адрес или откройте реализацию из состава приложения."
        />
      </PageStage>
    );
  if (
    !isImplementation &&
    featureRef !== undefined &&
    featureRef !== featureParent?.id &&
    featureRef !== featureParent?.key
  )
    return (
      <PageStage>
        <StatePanel
          titleAs="h1"
          title="Сценарий не принадлежит этой фиче"
          description="Проверьте адрес или откройте сценарий из каталога фич."
        />
      </PageStage>
    );
  const entityAddress = entity.canonicalRef ?? entity.key ?? entity.id;
  const viewPath = isImplementation
    ? `${applicationParent?.href}/implementations/${encodeURIComponent(entityAddress)}`
    : `${featureParent?.href}/scenarios/${entityAddress}`;
  const canonical = `${viewPath}${isEditing ? "/edit" : ""}`;
  if (canonical !== location.pathname)
    return (
      <Navigate
        to={`${canonical}${location.search}${location.hash}`}
        state={location.state}
        replace
      />
    );
  const title = fields.kind === "implementation" ? (meta.targetName ?? fields.title) : fields.name;
  const contributionTitle = fields.kind === "implementation" ? fields.title : title;
  const description = isImplementation
    ? `${meta.scenarioId === null ? "Реализация фичи" : "Реализация сценария"} · ${applicationParent?.title ?? "Приложение"}`
    : "Ожидаемое поведение и проверяемый результат.";
  const isInactive = fields.kind === "implementation" && !fields.active;
  if (isInactive && isEditing)
    return (
      <PageStage>
        <StatePanel
          titleAs="h1"
          title="Реализация неактивна"
          description="Участие приложения снято. Описание доступно для чтения."
          action={
            <Button component={Link} to={`${viewPath}${location.search}${location.hash}`}>
              К просмотру
            </Button>
          }
        />
      </PageStage>
    );
  const canEditImplementation = isImplementation && !isInactive && !isEditing;
  const viewHref = `${viewPath}${location.search}${location.hash}`;
  const editHref = `${viewPath}/edit${location.search}${location.hash}`;
  const contextReturn = getProductReturn(location.state, `${parent.href}${location.search}`, base);
  const editorState = { returnTo: contextReturn, editorReturnTo: viewHref };
  const hasStatus = meta?.status !== null && meta?.status !== undefined;
  const readinessLabel = meta.status !== null ? PRODUCT_STATUS_LABELS[meta.status] : undefined;
  const shouldShowImplementation = isImplementation && !isEditing;
  const shouldShowDocument = !isImplementation && !isEditing;
  const implementationTarget = meta.scenarioId ?? meta.featureId;
  const canShowDetails = shouldShowImplementation && implementationTarget !== null;
  const hasReadError =
    query.error !== undefined || summary.error !== undefined || parents.error !== undefined;
  const sourceParent = parentItems.find((entry) => entry.id === implementationTarget);
  const editorData =
    fields.kind === "implementation"
      ? {
          id: entity.id,
          revision: entity.revision,
          title: fields.title,
          description: fields.description,
          status: fields.status,
        }
      : null;
  const kindLabel = isImplementation ? "Реализация" : "Сценарий";
  return (
    <ProductPage
      title={title}
      description={description}
      meta={
        <>
          <span>{kindLabel}</span>
          <ProductKey value={entity.key} copyable />
          {hasStatus && <ProductReadiness status={meta.status ?? "none"} label={readinessLabel} />}
        </>
      }
      actions={
        <>
          {canEditImplementation && (
            <Button
              component={Link}
              to={editHref}
              state={editorState}
              variant="default"
              leftSection={<Pencil size={15} aria-hidden="true" />}
            >
              Редактировать вклад
            </Button>
          )}
          {!isImplementation && (
            <Button
              component={Link}
              to={editHref}
              state={editorState}
              variant="default"
              leftSection={<Pencil size={15} aria-hidden="true" />}
            >
              Редактировать сценарий
            </Button>
          )}
          <Button
            component={Link}
            variant="subtle"
            to={`${projectBase}/relations?root=${fields.kind}:${entity.id}`}
            leftSection={<Network size={15} aria-hidden="true" />}
          >
            Все связи и контекст
          </Button>
          {!isEditing && (
            <EntityDelete
              key={entity.id}
              kind={fields.kind}
              entityId={entity.id}
              onDeleted={() => navigate(parent.href, { replace: true })}
            />
          )}
        </>
      }
    >
      {hasReadError && (
        <Alert color="warning" title="Не удалось обновить запись">
          Показана последняя прочитанная версия. Ваш ввод сохранён.{" "}
          <Button
            size="compact-sm"
            variant="subtle"
            onClick={() => {
              void query.mutate();
              void summary.mutate();
              void parents.mutate();
            }}
          >
            Повторить
          </Button>
        </Alert>
      )}
      {isInactive && (
        <Alert title="Реализация неактивна">
          Участие приложения снято. Описание и прежние связи сохранены.
        </Alert>
      )}
      {isEditing && editorData !== null && (
        <ImplementationEditor
          key={entity.id}
          projectId={projectId}
          initial={editorData}
          onClose={() => navigate(viewHref, { replace: true, state: location.state })}
          onSaved={async () => {
            await query.mutate();
            await summary.mutate();
            navigate(viewHref, { replace: true, state: location.state });
          }}
        />
      )}
      {canShowDetails && (
        <ImplementationDetails
          key={entity.id}
          implementationId={entity.id}
          targetId={implementationTarget}
          title={contributionTitle}
          description={fields.description}
          applicationName={parent.title}
          applicationId={parent.id}
          applicationHref={parent.href}
          sourceHref={sourceParent?.href}
        />
      )}
      {shouldShowDocument && (
        <ProductRequirement
          key={entity.id}
          kind="scenario"
          targetId={entity.id}
          description={fields.description}
          parentName={parent.title}
          parentHref={parent.contextHref}
        />
      )}
      {!isEditing && (
        <EntityDocuments target={{ kind: fields.kind, id: entity.id }} targetTitle={title} />
      )}
      <Text size="xs" c="dimmed" className={styles.revision}>
        Ревизия {entity.revision} · ID {entity.id}
      </Text>
    </ProductPage>
  );
};
