import { Button } from "@mantine/core";
import { RefreshCw } from "lucide-react";
import { useProjectBasePath, useProjectId } from "domains/project";
import { useProductOverview } from "domains/product-overview";
import { StatePanel } from "ui/state-panel";
import { isDefined } from "shared/value-predicates";
import { OVERVIEW_SECTION_IDS } from "./config/overview.config";
import { getOverviewErrorMessage } from "./helpers/overview-error";
import { AttentionList } from "./ui/attention-list/attention-list";
import { BoardList } from "./ui/board-list/board-list";
import { OverviewHeader } from "./ui/overview-header/overview-header";
import { OverviewMetrics } from "./ui/overview-metrics/overview-metrics";
import { OverviewPanel } from "./ui/overview-panel/overview-panel";
import { PinnedDocuments } from "./ui/pinned-documents/pinned-documents";
import { PlanSummaries } from "./ui/plan-summaries/plan-summaries";
import { ProductKnowledge } from "./ui/product-knowledge/product-knowledge";
import { ProjectSize } from "./ui/project-size/project-size";
import { ReleaseSummaries } from "./ui/release-summaries/release-summaries";
import { SyncNotice } from "./ui/sync-notice/sync-notice";
import { TaskStages } from "./ui/task-stages/task-stages";
import styles from "./styles/overview.module.css";

/**
 * Показывает согласованный срез проекта в порядке чтения: продукт и актуальность,
 * операционные числа, распределение задач и внимание, планы и релизы, затем размер
 * проекта и справочный контекст — знания, доски и документы. Содержимое лежит на
 * светлой сцене поверх серой области экрана; блоки — тонированные карточки на сцене.
 *
 * Используется для:
 *  - входа в проект и ориентации «что это и что происходит»
 *  - перехода к полным разделам для продолжения работы
 */
export const OverviewScreen = () => {
  const projectId = useProjectId();
  const basePath = useProjectBasePath();
  const overview = useProductOverview(projectId);
  const { data, error, isValidating, mutate } = overview;
  const retry = () => void mutate();
  const retryButton = (
    <Button
      variant="default"
      loading={isValidating}
      leftSection={<RefreshCw size={14} aria-hidden="true" />}
      onClick={retry}
    >
      Повторить чтение
    </Button>
  );

  if (!isDefined(data) && isDefined(error)) {
    return (
      <StatePanel
        title="Не удалось загрузить обзор"
        titleAs="h1"
        description={getOverviewErrorMessage(error)}
        action={retryButton}
      />
    );
  }

  if (!isDefined(data)) {
    return <StatePanel title="Обзор" titleAs="h1" description="Читаем срез проекта…" isLoading />;
  }

  const refreshError = isDefined(error) ? getOverviewErrorMessage(error) : null;
  const { plans, releases, documents, boards } = data;
  const tasksDescription =
    `Где сейчас находятся все задачи проекта со всех досок (${boards.total}): ` +
    "каждая задача учтена ровно в одной колонке.";
  return (
    <div className={styles.root}>
      <div className={styles.stage}>
        <OverviewHeader
          project={data.project}
          passport={data.passport}
          generatedAt={data.generatedAt}
          freshness={overview.freshness}
          passportPath={`${basePath}/product/passport`}
        />
        <SyncNotice
          freshness={overview.freshness}
          storageMessage={overview.message}
          refreshError={refreshError}
          isRetrying={isValidating}
          onRetry={retry}
        />
        <OverviewMetrics tasks={data.tasks} />
        <div className={styles.grid}>
          <OverviewPanel
            id={OVERVIEW_SECTION_IDS.tasks}
            className={styles.tasks}
            title="Задачи по колонкам"
            total={data.tasks.total}
            description={tasksDescription}
            tone="feature"
            link={{ to: `${basePath}/boards/product`, label: "Доска продукта" }}
          >
            <TaskStages tasks={data.tasks} />
          </OverviewPanel>
          <OverviewPanel title="Требует внимания" className={styles.attention}>
            <AttentionList
              attention={data.attention}
              basePath={basePath}
              className={styles.attentionBody}
            />
          </OverviewPanel>
          <OverviewPanel
            title="Планы"
            className={styles.plans}
            total={plans.total}
            link={{ to: `${basePath}/plans`, label: "Все планы" }}
            preview={{ shown: plans.active.items.length, total: plans.active.total }}
          >
            <PlanSummaries plans={plans} basePath={basePath} />
          </OverviewPanel>
          <OverviewPanel
            title="Релизы"
            className={styles.releases}
            total={releases.total}
            link={{ to: `${basePath}/releases`, label: "Все релизы" }}
          >
            <ReleaseSummaries releases={releases} basePath={basePath} />
          </OverviewPanel>
          <OverviewPanel
            title="Размер проекта"
            className={styles.size}
            description="Сколько записей каждого вида в проекте. Длина полосы — относительно самого большого числа."
          >
            <ProjectSize
              tasks={data.tasks}
              boards={boards}
              documents={documents}
              knowledge={data.knowledge}
              basePath={basePath}
            />
          </OverviewPanel>
          <OverviewPanel
            title="Продуктовые знания"
            className={styles.knowledge}
            link={{ to: `${basePath}/product/features`, label: "Все фичи" }}
          >
            <ProductKnowledge knowledge={data.knowledge} />
          </OverviewPanel>
          <OverviewPanel
            id={OVERVIEW_SECTION_IDS.boards}
            className={styles.boards}
            title="Доски"
            total={boards.total}
          >
            <BoardList catalog={boards.catalog} basePath={basePath} />
          </OverviewPanel>
          <OverviewPanel
            title="Документы"
            className={styles.documents}
            total={documents.total}
            link={{ to: `${basePath}/documents`, label: "Библиотека знаний" }}
            preview={{
              shown: documents.pinnedActive.items.length,
              total: documents.pinnedActive.total,
            }}
          >
            <PinnedDocuments documents={documents} basePath={basePath} />
          </OverviewPanel>
        </div>
      </div>
    </div>
  );
};
