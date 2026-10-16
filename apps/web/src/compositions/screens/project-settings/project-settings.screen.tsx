import { Alert, Anchor, Button } from "@mantine/core";
import { Link } from "react-router-dom";
import { ArrowLeft, RefreshCw, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { useProjectBasePath, useProjectSettings } from "domains/project";
import { isDefined } from "shared/value-predicates";
import { PageHeader } from "ui/page-header";
import { PageStage } from "ui/page-stage";
import { StatePanel } from "ui/state-panel";
import { GeneralSettings } from "./ui/general-settings";
import styles from "./styles/project-settings.module.css";

/**
 * Представляет настройки текущего проекта как отдельный расширяемый раздел.
 *
 * Используется для:
 *  - чтения и изменения имени и адреса проекта
 *  - отображения загрузки и восстановления после ошибки чтения
 */
export const ProjectSettingsScreen = () => {
  const basePath = useProjectBasePath();
  const query = useProjectSettings();
  const settingsData = query.data;
  const hasSettings = isDefined(settingsData);
  const hasLoadError = isDefined(query.error);
  const retryButton = (
    <Button
      variant="default"
      loading={query.isValidating}
      leftSection={<RefreshCw size={14} aria-hidden="true" />}
      onClick={() => void query.mutate()}
    >
      Повторить загрузку
    </Button>
  );
  return (
    <PageStage className={styles.root}>
      <PageHeader
        meta={
          <Anchor component={Link} to={`${basePath}/`} className={styles.back}>
            <ArrowLeft size={14} aria-hidden="true" /> К проекту
          </Anchor>
        }
        title="Настройки проекта"
        description="Всё, что определяет ваш проект в Relay."
      />
      <div className={styles.layout}>
        <nav className={styles.navigation} aria-label="Разделы настроек">
          <p className={styles.caption} aria-hidden="true">
            Настройки
          </p>
          <a href="#general" className={styles.sectionLink} aria-current="location">
            <SlidersHorizontal size={18} aria-hidden="true" className={styles.sectionIcon} />
            <span className={styles.sectionText}>
              Основное<span className={styles.sectionDescription}>Имя и адрес проекта</span>
            </span>
          </a>
        </nav>
        <div className={styles.content}>
          {hasSettings && hasLoadError && (
            <Alert
              color="warning"
              title="Не удалось обновить настройки"
              icon={<TriangleAlert size={18} aria-hidden="true" />}
              className={styles.notice}
            >
              Показаны последние загруженные значения; ваш ввод не изменён.
              <div className={styles.noticeAction}>{retryButton}</div>
            </Alert>
          )}
          {hasSettings && <GeneralSettings settings={settingsData} />}
          {!hasSettings && hasLoadError && (
            <StatePanel
              state="error"
              title="Не удалось загрузить настройки"
              description="Проверьте подключение к серверу Relay и повторите загрузку."
              action={retryButton}
            />
          )}
          {!hasSettings && !hasLoadError && (
            <StatePanel
              state="loading"
              title="Загружаем настройки"
              description="Читаем имя и адрес проекта."
            />
          )}
        </div>
      </div>
    </PageStage>
  );
};
