import type {
  OverviewPlans,
  OverviewReleases,
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

/** Резервный заголовок записи без названия. */
export const UNTITLED = "Без названия";
