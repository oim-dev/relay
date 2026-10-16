import type { WorkGraphPointDetail } from "domains/work-history";

/** Объяснение сохранённого события для читателя и название его основного материала. */
type PointReadingGuide = {
  /** Коротко объясняет, что зафиксировано именно этой записью. */
  description: string;
  /** Название основного Markdown-раздела. */
  materialLabel: string;
};

/** Подписи описывают вид записи, а не текущее состояние всей работы. */
const CHECKPOINT_GUIDES = {
  intent: {
    description: "План действий и ожидаемый результат, зафиксированные перед выполнением.",
    materialLabel: "План работы",
  },
  progress: {
    description: "Наблюдения, решения и ход выполнения отдельного намерения.",
    materialLabel: "Промежуточные результаты",
  },
  result: {
    description: "Итог выполнения отдельного намерения. Вся ветка работы может продолжаться.",
    materialLabel: "Результат",
  },
  cancel: {
    description: "Причина отмены отдельного намерения. Остальная работа может продолжаться.",
    materialLabel: "Причина отмены",
  },
} satisfies Record<NonNullable<WorkGraphPointDetail["checkpoint"]>["kind"], PointReadingGuide>;

/**
 * Объясняет различие между материалами намерения, событиями ветки и участием агента.
 */
export const getPointReadingGuide = (detail: WorkGraphPointDetail): PointReadingGuide => {
  const { point, checkpoint, session, run } = detail;
  if (checkpoint !== null) return CHECKPOINT_GUIDES[checkpoint.kind];
  if (point.kind === "session-created")
    return {
      description:
        session.parentSessionId === null
          ? "Исходное поручение, с которого началась эта ветка работы."
          : "Поручение, выделенное в отдельную дочернюю ветку работы.",
      materialLabel: "Поручение",
    };
  if (point.kind === "session-closed")
    return session.status === "cancelled"
      ? {
          description: "Ветка работы закрыта с отменой; ниже сохранена причина.",
          materialLabel: "Причина отмены",
        }
      : {
          description: "Сохранённый итог завершения всей ветки работы.",
          materialLabel: "Итог работы",
        };
  if (point.kind === "run-started")
    return {
      description:
        point.predecessorRunId === null
          ? "Запись о начале участия агента в этой ветке работы."
          : "Работа передана новому участию агента; ниже сохранена причина передачи.",
      materialLabel: "Причина подключения или передачи",
    };
  if (run?.endReason === "paused")
    return {
      description: "Участие агента приостановлено; ниже сохранён материал паузы.",
      materialLabel: "Причина паузы",
    };
  if (run?.endReason === "transferred")
    return {
      description: "Запись об окончании участия агента при передаче работы.",
      materialLabel: "Материал передачи",
    };
  return {
    description:
      run?.endReason === "cancelled"
        ? "Запись об отмене участия этого агента в ветке работы."
        : "Запись об окончании участия этого агента в ветке работы.",
    materialLabel: "Материал окончания участия",
  };
};
