import { Button } from "@mantine/core";
import { StatePanel } from "ui/state-panel";
import { PageBreadcrumbs } from "compositions/widgets/page-breadcrumbs";

/**
 * Даёт восстановить приложение после неожиданной ошибки маршрута.
 *
 * Используется для:
 *  - восстановления рабочего пространства после сбоя
 */
export const RouteError = () => (
  <main>
    <PageBreadcrumbs
      items={[
        { id: "relay", label: "Relay", href: "/" },
        { id: "error", label: "Ошибка страницы" },
      ]}
    />
    <StatePanel
      state="error"
      title="Не удалось открыть страницу"
      description="Обновите приложение. Сохранённые локальные черновики останутся доступны."
      action={<Button onClick={() => window.location.reload()}>Обновить страницу</Button>}
    />
  </main>
);
