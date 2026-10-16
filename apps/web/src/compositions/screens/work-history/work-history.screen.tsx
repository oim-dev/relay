import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useProjectId } from "domains/project";
import { HistoryGraph } from "./ui/history-graph";
import { GraphPointModal } from "./ui/graph-point-modal";
import styles from "./styles/work-history.module.css";

/**
 * Координирует граф всего проекта и адресное чтение выбранной точки.
 *
 * Используется для:
 *  - навигации по точкам без фильтров и скрытого сужения области
 *  - совместимости прежних CP-ссылок и возврата из модального окна в тот же граф
 */
export const WorkHistoryScreen = () => {
  const projectId = useProjectId();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const pointRef = params.get("point") ?? params.get("checkpoint");
  const sessionRef = params.get("session");
  const screenRef = useRef<HTMLElement>(null);
  const sourceRef = useRef<HTMLButtonElement | null>(null);
  const previousPointRef = useRef<string | null>(null);
  const routeState: unknown = location.state;
  const wasOpenedHere =
    routeState !== null &&
    typeof routeState === "object" &&
    "workGraphProject" in routeState &&
    routeState.workGraphProject === projectId &&
    "workGraphOpenedHere" in routeState &&
    routeState.workGraphOpenedHere === true;
  useEffect(() => {
    const previous = previousPointRef.current;
    previousPointRef.current = pointRef;
    if (previous === null || pointRef !== null) return;
    const frame = requestAnimationFrame(() => {
      const source = sourceRef.current;
      if (source?.isConnected) source.focus({ preventScroll: true });
      else screenRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [pointRef]);
  /**
   * Открывает материал, не перемонтируя холст и не меняя project-wide query.
   */
  const handleSelectPoint = useCallback(
    (ref: string, source?: HTMLButtonElement): void => {
      if (source !== undefined && pointRef === null) sourceRef.current = source;
      const next = new URLSearchParams(params);
      for (const key of ["checkpoint", "tree", "q", "status", "unfinished", "children", "order"])
        next.delete(key);
      next.set("point", ref);
      navigate(
        { search: `?${next}` },
        {
          preventScrollReset: true,
          replace: pointRef !== null,
          state: {
            workGraphProject: projectId,
            workGraphOpenedHere: wasOpenedHere || pointRef === null,
          },
        },
      );
    },
    [navigate, params, pointRef, projectId, wasOpenedHere],
  );
  /**
   * UI-открытие возвращается Back, прямая ссылка снимает только выбор точки.
   */
  const handleClosePoint = (): void => {
    if (wasOpenedHere) {
      navigate(-1);
      return;
    }
    const next = new URLSearchParams(params);
    next.delete("point");
    next.delete("checkpoint");
    setParams(next, { replace: true, preventScrollReset: true });
  };
  const hasPoint = pointRef !== null;
  return (
    <section
      ref={screenRef}
      tabIndex={-1}
      className={styles.root}
      aria-labelledby="work-history-title"
    >
      <h1 id="work-history-title" className={styles.visuallyHidden}>
        История
      </h1>
      <HistoryGraph
        key={projectId}
        projectId={projectId}
        selectedPoint={pointRef}
        highlightedSession={sessionRef}
        onSelectPoint={handleSelectPoint}
      />
      {hasPoint && (
        <GraphPointModal
          key={`point-modal:${projectId}`}
          projectId={projectId}
          pointRef={pointRef}
          onClose={handleClosePoint}
          onSelectPoint={handleSelectPoint}
        />
      )}
    </section>
  );
};
