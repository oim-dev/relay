import { Ban, CircleCheck, CirclePlay, Eye, Flag, Inbox, Lock } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  OverviewBoard,
  OverviewObligationReason,
  OverviewPlans,
  OverviewReleases,
  OverviewTasks,
  ProductOverviewFreshness,
} from "domains/product-overview";

/** Короткое состояние актуальности рядом со временем получения среза. */
export const FRESHNESS_LABELS: Record<ProductOverviewFreshness, string> = {
  live: "Актуально",
  refreshing: "Обновляем",
  connecting: "Подключаемся к обновлениям",
  offline: "Нет соединения",
  stale: "Данные устарели",
  "storage-error": "Ошибка хранилища",
};

/** Подписи собственных статусов планов во множественном числе. */
export const PLAN_STATUS_COUNT_LABELS: Record<keyof OverviewPlans["byStatus"], string> = {
  draft: "Запланированы",
  active: "В работе",
  completed: "Завершены",
  cancelled: "Отменены",
};

/** Подписи собственных статусов релизов во множественном числе. */
export const RELEASE_STATUS_COUNT_LABELS: Record<keyof OverviewReleases["byStatus"], string> = {
  planned: "Запланированы",
  released: "Выпущены",
  cancelled: "Отменены",
};

/** Подписи фактической готовности требований. */
export const READINESS_LABELS: Record<"done" | "partial" | "none", string> = {
  done: "реализовано",
  partial: "частично",
  none: "впереди",
};

/** Область ответственности доски вместо счётчиков, которых нет в полном каталоге. */
export const BOARD_KIND_LABELS: Record<OverviewBoard["kind"], string> = {
  product: "продукт",
  application: "приложение",
  infrastructure: "инфраструктура",
};

/** Подписи причин невыполненных обязательств задачи. */
export const OBLIGATION_REASON_LABELS: Record<OverviewObligationReason, string> = {
  criterion: "критерии приёмки",
  dependency: "зависимость",
  child: "подзадача",
};

/** Подписи прямой связи задачи с блокером. */
export const BLOCKER_RELATION_LABELS = { dependency: "зависимость", subtask: "подзадача" } as const;

/** Подписи собственных статусов плана в единственном числе. */
export const PLAN_STATUS_LABELS: Record<keyof OverviewPlans["byStatus"], string> = {
  draft: "Запланирован",
  active: "В работе",
  completed: "Завершён",
  cancelled: "Отменён",
};

/** Резервный заголовок записи без названия. */
export const UNTITLED = "Без названия";

/** Якоря блоков обзора, к которым ведут показатели без собственного раздела. */
export const OVERVIEW_SECTION_IDS = {
  tasks: "overview-tasks",
  taskFacts: "overview-task-facts",
  attentionInProgress: "overview-attention-in-progress",
  attentionReview: "overview-attention-review",
  attentionBlocked: "overview-attention-blocked",
  boards: "overview-boards",
  boardWork: "overview-board-work",
  blockerImpact: "overview-blocker-impact",
} as const;

/**
 * Единая система иконок колонок и блокировки: одинаковы в операционных показателях
 * и на диаграмме колонок, чтобы состояние узнавалось не только по цвету.
 */
export const TASK_STATE_ICONS: Record<keyof OverviewTasks["byColumn"] | "blocked", LucideIcon> = {
  inbox: Inbox,
  ready: Flag,
  "in-progress": CirclePlay,
  review: Eye,
  done: CircleCheck,
  cancelled: Ban,
  blocked: Lock,
};
