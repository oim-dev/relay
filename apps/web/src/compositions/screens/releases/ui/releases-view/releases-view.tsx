import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Alert, Button } from "@mantine/core";
import { useProjectBasePath, useProjectId } from "domains/project";
import {
  createReleaseDraft,
  useRelease,
  saveRelease,
  useReleasesRefresh,
  ReleaseError,
} from "domains/releases";
import type { Release, ReleaseStatus } from "domains/releases";
import { isDefined } from "shared/value-predicates";
import { StatePanel } from "ui/state-panel";
import { ReleaseCatalog } from "../release-catalog";
import { ReleaseDetail } from "../release-detail";
import { ReleaseForm } from "../release-form";

/**
 * Координирует каталог, просмотр и создание самостоятельных релизов.
 *
 * Используется для:
 *  - сохранения выбранных планов и собственного статуса выпуска
 */
export const ReleasesView = () => {
  const projectId = useProjectId();
  const basePath = useProjectBasePath();
  const navigate = useNavigate();
  const { releaseId } = useParams();
  const releaseQuery = useRelease(projectId, releaseId ?? null);
  const refresh = useReleasesRefresh(projectId);
  const [editor, setEditor] = useState<Release | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const releaseData = releaseQuery.data;
  const hasUnknownRelease =
    releaseQuery.error instanceof ReleaseError && releaseQuery.error.code === "ENTITY_NOT_FOUND";
  const isNew = editor?.revision === 0;

  /**
   * Форма снимается вместе с состоянием, поэтому фокус после закрытия возвращает владелец —
   * к вызвавшей кнопке, если она осталась на экране; новый адрес фокусирует свой заголовок сам.
   */
  useEffect(() => {
    if (isDefined(editor) || openerRef.current === null) return;
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener.isConnected) opener.focus({ preventScroll: true });
  }, [editor]);

  /**
   * Запоминает элемент, вызвавший форму.
   */
  const rememberOpener = (): void => {
    if (document.activeElement instanceof HTMLElement) openerRef.current = document.activeElement;
  };

  /**
   * Открывает новую сущность с пустым составом и статусом «Запланирован».
   */
  const handleCreate = () => {
    rememberOpener();
    setEditor(createReleaseDraft());
  };

  /**
   * Сохраняет релиз, затем открывает его постоянный адрес.
   */
  const handleSave = async (release: Release): Promise<string | null> => {
    try {
      const saved = await saveRelease(projectId, release);
      void refresh().catch(() => undefined);
      // Изменение остаётся на текущем адресе: переход по id при открытии по ключу
      // сменил бы ключ чтения и заменил показанный релиз загрузкой.
      if (isNew) navigate(`${basePath}/releases/${saved.id}`);
      return null;
    } catch (error) {
      if (error instanceof ReleaseError) return error.message;
      throw error;
    }
  };

  /**
   * Открывает предметную форму, при необходимости предлагая новый статус.
   */
  const handleEdit = (status?: ReleaseStatus) => {
    if (!isDefined(releaseData)) return;
    rememberOpener();
    setEditor({ ...releaseData, status: status ?? releaseData.status });
  };

  if (isDefined(releaseId) && releaseQuery.isLoading && !isDefined(releaseData))
    return (
      <StatePanel
        state="loading"
        title="Загружаем релиз"
        titleAs="h1"
        description="Читаем постоянные данные проекта."
      />
    );
  if (isDefined(releaseQuery.error) && !isDefined(releaseData) && !hasUnknownRelease)
    return (
      <StatePanel
        state="error"
        title="Не удалось прочитать релиз"
        titleAs="h1"
        description={releaseQuery.error.message}
        action={
          <Button variant="default" onClick={() => void releaseQuery.mutate()}>
            Повторить чтение
          </Button>
        }
      />
    );
  if (hasUnknownRelease && !isDefined(releaseData))
    return (
      <StatePanel
        title="Релиз не найден"
        titleAs="h1"
        description="В этом проекте нет релиза с таким адресом."
        action={
          <Button component={Link} to={`${basePath}/releases`} variant="default">
            Все релизы
          </Button>
        }
      />
    );

  return (
    <>
      {isDefined(releaseQuery.error) && (
        <Alert color="warning" title="Не удалось обновить релиз">
          Показана последняя прочитанная версия. {releaseQuery.error.message}
          <Button size="xs" variant="subtle" onClick={() => void releaseQuery.mutate()}>
            Повторить чтение
          </Button>
        </Alert>
      )}
      {!isDefined(releaseId) && <ReleaseCatalog basePath={basePath} onCreate={handleCreate} />}
      {isDefined(releaseData) && (
        <ReleaseDetail
          key={`release-${releaseData.id}`}
          release={releaseData}
          basePath={basePath}
          onEdit={handleEdit}
        />
      )}
      {isDefined(editor) && (
        <ReleaseForm
          key={`editor-${editor.id}`}
          release={editor}
          projectId={projectId}
          isNew={isNew}
          onSave={handleSave}
          onClose={() => setEditor(null)}
        />
      )}
    </>
  );
};
