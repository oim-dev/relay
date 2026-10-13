import { useState } from "react";
import clsx from "clsx";
import { ActionIcon, Drawer, Select, Tooltip, VisuallyHidden } from "@mantine/core";
import { Layers3, Menu, Moon, Settings, Sun } from "lucide-react";
import { RecordRow } from "ui/record-row";
import { SectionPanel } from "ui/section-panel";
import { StatusBadge } from "ui/status-badge";
import { useThemeColorScheme } from "ui/themes";
import { PageBreadcrumbs } from "compositions/widgets/page-breadcrumbs";
import {
  SHELL_ATTENTION,
  SHELL_PRODUCT_ITEMS,
  SHELL_PROJECT_NAME,
  SHELL_PROJECTS,
  SHELL_TOP_ITEMS,
  SHELL_WORK_ITEMS,
} from "./config/shell.config";
import { KitShellNav } from "./ui/kit-shell-nav/kit-shell-nav";
import type { KitShellProps } from "./types/kit-shell-props.type";
import styles from "./styles/kit-shell.module.css";

/** Подписи разделов примера по идентификатору, включая настройки из шапки. */
const SECTION_LABELS = new Map<string, string>([
  ...[...SHELL_TOP_ITEMS, ...SHELL_PRODUCT_ITEMS, ...SHELL_WORK_ITEMS].map(
    (item) => [item.id, item.label] as const,
  ),
  ["settings", "Настройки проекта"],
]);

/**
 * Композиционный пример каркаса проекта на общей подложке: прозрачные шапка и сайдбар,
 * выбор проекта, хлебные крошки, заголовок и панели в ритме --tasks-panel-gap.
 * Геометрия и роли — те же токены, что у настоящего каркаса; данные демонстрационные.
 *
 * Используется для:
 *  - сверки макета галереи с живыми маршрутами на desktop и узком экране
 *  - проверки клавиатуры, раскрытия группы, Drawer и возврата фокуса
 */
export const KitShell = (props: KitShellProps) => {
  const { variant, className, ...rootAttrs } = props;
  const [currentId, setCurrentId] = useState("releases");
  const [isNavigationOpen, setNavigationOpen] = useState(false);
  const { computedColorScheme, setColorScheme } = useThemeColorScheme();
  const isMobile = variant === "mobile";
  const variantClass = isMobile ? styles._mobile : undefined;
  const isDark = computedColorScheme === "dark";
  const ThemeIcon = isDark ? Sun : Moon;
  const themeLabel = isDark ? "Включить светлую тему" : "Включить тёмную тему";
  const isSettings = currentId === "settings";
  const settingsVariant = isSettings ? "light" : "subtle";
  const settingsCurrent = isSettings ? "page" : undefined;
  const isProductSection = SHELL_PRODUCT_ITEMS.some((item) => item.id === currentId);
  const pageTitle = SECTION_LABELS.get(currentId) ?? "Раздел";
  const breadcrumbs = [
    { id: "project", label: SHELL_PROJECT_NAME, href: "/dev/ui-kit" },
    ...(isProductSection ? [{ id: "product", label: "Продукт", href: "/dev/ui-kit" }] : []),
    { id: currentId, label: pageTitle },
  ];
  // На странице галереи несколько цепочек: у каждого примера своя подпись ориентира.
  // Скрытое уточнение панелей делает их ориентиры различимыми среди других примеров.
  const exampleName = isMobile ? "узкий экран" : "desktop";
  const breadcrumbsLabel = `Хлебные крошки примера: ${exampleName}`;
  const panelSuffix = <VisuallyHidden>{`, пример каркаса: ${exampleName}`}</VisuallyHidden>;
  const selectFromDrawer = (id: string) => {
    setCurrentId(id);
    setNavigationOpen(false);
  };

  return (
    <div {...rootAttrs} className={clsx(styles.root, variantClass, className)}>
      <header className={clsx(styles.header, variantClass)}>
        <div className={styles.identity}>
          <ActionIcon
            className={clsx(styles.menuToggle, variantClass)}
            aria-label="Открыть навигацию примера"
            aria-expanded={isNavigationOpen}
            aria-haspopup="dialog"
            onClick={() => setNavigationOpen(true)}
          >
            <Menu size={20} aria-hidden="true" />
          </ActionIcon>
          <Layers3 size={22} className={clsx(styles.brandIcon, variantClass)} aria-hidden="true" />
          <span className={clsx(styles.brand, variantClass)}>Relay</span>
          <span className={clsx(styles.divider, variantClass)} aria-hidden="true">
            /
          </span>
          <Select
            aria-label="Выбрать проект примера"
            title={SHELL_PROJECT_NAME}
            data={SHELL_PROJECTS}
            defaultValue="support"
            allowDeselect={false}
            variant="navigation"
            comboboxProps={{ width: 320, position: "bottom-start" }}
          />
        </div>
        <div className={styles.actions}>
          <Tooltip label={themeLabel}>
            <ActionIcon
              aria-label={themeLabel}
              onClick={() => setColorScheme(isDark ? "light" : "dark")}
            >
              <ThemeIcon size={18} aria-hidden="true" />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Настройки проекта">
            <ActionIcon
              variant={settingsVariant}
              aria-label="Настройки проекта"
              aria-current={settingsCurrent}
              onClick={() => setCurrentId("settings")}
            >
              <Settings size={18} aria-hidden="true" />
            </ActionIcon>
          </Tooltip>
        </div>
      </header>
      <div className={clsx(styles.workspace, variantClass)}>
        {!isMobile && (
          <aside className={styles.sidebar}>
            <p className={styles.sectionLabel} aria-hidden="true">
              Проект
            </p>
            <KitShellNav currentId={currentId} onSelect={setCurrentId} />
          </aside>
        )}
        <div className={styles.content}>
          <PageBreadcrumbs items={breadcrumbs} aria-label={breadcrumbsLabel} />
          <div className={styles.stage}>
            <div className={styles.pageHeader}>
              <p className={styles.meta}>{SHELL_PROJECT_NAME}</p>
              <h4 className={styles.pageTitle}>{pageTitle}</h4>
            </div>
            <div className={clsx(styles.grid, variantClass)}>
              <SectionPanel
                titleAs="h3"
                title={
                  <>
                    Задачи по колонкам
                    {panelSuffix}
                  </>
                }
                tone="feature"
                count={128}
                countLabel="Задач"
              >
                <p className={styles.metric}>
                  42<VisuallyHidden> задачи</VisuallyHidden>
                  <span className={styles.metricNote}>в работе</span>
                </p>
              </SectionPanel>
              <SectionPanel
                titleAs="h3"
                title={
                  <>
                    Требует внимания
                    {panelSuffix}
                  </>
                }
                count={SHELL_ATTENTION.length}
              >
                <ul className={styles.rows}>
                  {SHELL_ATTENTION.map((row) => (
                    <RecordRow
                      key={row.id}
                      component="li"
                      code={row.code}
                      title={<a href="#kit-shell">{row.title}</a>}
                      trailing={<StatusBadge tone="warning">{row.status}</StatusBadge>}
                    />
                  ))}
                </ul>
              </SectionPanel>
              <SectionPanel
                className={styles.wide}
                titleAs="h3"
                title={
                  <>
                    Материалы проекта
                    {panelSuffix}
                  </>
                }
                description="Третья панель той же сетки: зазор между панелями — --tasks-panel-gap."
              >
                <p className={styles.note}>
                  Заголовок и путь стоят на подложке; поверхность получают только панели.
                </p>
              </SectionPanel>
            </div>
          </div>
        </div>
      </div>
      <Drawer
        opened={isNavigationOpen}
        onClose={() => setNavigationOpen(false)}
        position="left"
        size="min(20rem, calc(100vw - 2rem))"
        title="Разделы примера"
        closeButtonProps={{ "aria-label": "Закрыть навигацию" }}
        variant="navigation"
      >
        <KitShellNav currentId={currentId} onSelect={selectFromDrawer} />
      </Drawer>
    </div>
  );
};
