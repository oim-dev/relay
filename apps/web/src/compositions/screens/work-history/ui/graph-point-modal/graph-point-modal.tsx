import { Button, Modal, Skeleton } from "@mantine/core";
import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useMediaQuery } from "@mantine/hooks";
import { Bot, ChevronDown, ChevronUp } from "lucide-react";
import { useWorkGraphPoint } from "domains/work-history";
import { isDefined } from "shared/value-predicates";
import { BranchPoints } from "compositions/screens/work-history/ui/graph-point-modal/ui/branch-points";
import { PointReport } from "compositions/screens/work-history/ui/graph-point-modal/ui/point-report";
import { PointContext } from "compositions/screens/work-history/ui/graph-point-modal/ui/point-context";
import type { GraphPointModalProps } from "./types/graph-point-modal-props.type";
import styles from "./styles/graph-point-modal.module.css";

/**
 * Координирует чтение материалов и переключение точек в одном устойчивом окне.
 *
 * Используется для:
 *  - одноколоночного чтения больших материалов с компактной навигацией
 *  - сохранения списка ветки при загрузке выбранной точки
 */
export const GraphPointModal = (props: GraphPointModalProps) => {
  const { projectId, pointRef, onClose, onSelectPoint } = props;
  const query = useWorkGraphPoint(projectId, pointRef);
  const isMobile = useMediaQuery("(max-width: 47.99em)");
  const detail = query.data;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const navigationButtonRef = useRef<HTMLButtonElement>(null);
  const navigationId = useId();
  const [isNavigationOpen, setIsNavigationOpen] = useState(false);
  const [hasOpenedNavigation, setHasOpenedNavigation] = useState(false);
  const [navigationSessionId, setNavigationSessionId] = useState<string | null>(null);
  const sessionId = detail?.session.id ?? navigationSessionId;
  const selectedPointId = detail?.point.id ?? pointRef;
  const loadedPointId = detail?.point.id;
  useEffect(() => {
    if (loadedPointId === undefined) return;
    contentRef.current?.scrollTo({ top: 0 });
    titleRef.current?.focus({ preventScroll: true });
  }, [loadedPointId]);
  const hasError = isDefined(query.error);
  const canNavigate = isDefined(sessionId);
  const mountedSessionId = hasOpenedNavigation ? sessionId : null;
  const NavigationIcon = isNavigationOpen ? ChevronUp : ChevronDown;
  const agentName = detail?.run?.actor ?? "Агент не указан";
  const windowTitle = isDefined(detail) ? agentName : "История работы";
  const windowLabel = isDefined(detail) ? `История работы · Агент: ${agentName}` : "История работы";
  const workTitle = isDefined(detail) ? `Работа: ${detail.session.title}` : "";

  /**
   * Загружает список при первом открытии и затем сохраняет его экземпляр скрытым.
   */
  const handleToggleNavigation = (): void => {
    setHasOpenedNavigation(true);
    setIsNavigationOpen((opened) => !opened);
  };

  /**
   * Удерживает контекст навигации, пока отдельный запрос разрешает новую точку.
   */
  const handleSelectPoint = (ref: string): void => {
    setNavigationSessionId(sessionId);
    setIsNavigationOpen(false);
    if (ref === detail?.point.id) {
      contentRef.current?.scrollTo({ top: 0 });
      titleRef.current?.focus({ preventScroll: true });
      return;
    }
    navigationButtonRef.current?.focus({ preventScroll: true });
    onSelectPoint(ref);
  };

  /**
   * Первое Escape закрывает выбор точки и возвращает фокус на его кнопку.
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing || !isNavigationOpen) return;
    event.preventDefault();
    event.stopPropagation();
    setIsNavigationOpen(false);
    navigationButtonRef.current?.focus({ preventScroll: true });
  };
  return (
    <Modal.Root
      opened
      centered
      size="65rem"
      xOffset="1.5rem"
      yOffset="1.5rem"
      fullScreen={isMobile}
      closeOnEscape={!isNavigationOpen}
      onClose={onClose}
      returnFocus={false}
      classNames={{ content: styles.root, header: styles.header, body: styles.body }}
    >
      <Modal.Overlay />
      <Modal.Content onKeyDownCapture={handleKeyDown}>
        <Modal.Header role="presentation">
          <Modal.Title className={styles.windowTitle} aria-label={windowLabel}>
            <span className={styles.agentIcon}>
              <Bot size={20} aria-hidden />
            </span>
            <span>{windowTitle}</span>
          </Modal.Title>
          <Button
            ref={navigationButtonRef}
            variant="subtle"
            className={styles.navigationButton}
            rightSection={<NavigationIcon size={16} aria-hidden />}
            aria-expanded={isNavigationOpen}
            aria-controls={navigationId}
            disabled={!canNavigate}
            onClick={handleToggleNavigation}
          >
            Точки ветки
          </Button>
          <Modal.CloseButton className={styles.closeButton} aria-label="Закрыть материал точки" />
          <p className={styles.workTitle}>{workTitle}</p>
        </Modal.Header>
        <div id={navigationId} hidden={!isNavigationOpen} className={styles.navigation}>
          {isDefined(mountedSessionId) && (
            <BranchPoints
              key={mountedSessionId}
              projectId={projectId}
              sessionId={mountedSessionId}
              selectedPointId={selectedPointId}
              onSelectPoint={handleSelectPoint}
            />
          )}
        </div>
        <Modal.Body ref={contentRef}>
          {query.isLoading && (
            <div className={styles.pending} role="status">
              <p>Читаем материал точки…</p>
              <Skeleton height={30} width="70%" animate={false} />
              <Skeleton height={44} width="45%" animate={false} />
              <Skeleton height={160} animate={false} />
            </div>
          )}
          {hasError && (
            <div role="alert" className={styles.error}>
              <p>{query.error?.message}</p>
              <Button
                variant="default"
                mih={44}
                onClick={() => void query.mutate().catch(() => undefined)}
              >
                Повторить чтение точки
              </Button>
            </div>
          )}
          {isDefined(detail) && (
            <>
              <PointReport detail={detail} titleRef={titleRef} />
              <PointContext
                key={detail.point.id}
                detail={detail}
                onSelectPoint={handleSelectPoint}
              />
            </>
          )}
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
};
