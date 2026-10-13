import { ActionIcon, Breadcrumbs, Menu } from "@mantine/core";
import { useResizeObserver } from "@mantine/hooks";
import { ChevronRight, Ellipsis } from "lucide-react";
import clsx from "clsx";
import { isDefined } from "shared/value-predicates";
import { BreadcrumbItem } from "./ui/breadcrumb-item/breadcrumb-item";
import type { PageBreadcrumbsProps } from "./types/page-breadcrumbs-props.type";
import styles from "./styles/page-breadcrumbs.module.css";

/**
 * Показывает путь страницы и сохраняет доступ к предкам при недостатке места.
 *
 * Используется для:
 *  - общей навигации проекта и служебных страниц
 *  - доступных переходов внутри модального окна задачи
 */
export const PageBreadcrumbs = (props: PageBreadcrumbsProps) => {
  const {
    items,
    embedded = false,
    className,
    "aria-label": label = "Хлебные крошки",
    ...rootAttrs
  } = props;
  const [containerRef, containerRect] = useResizeObserver<HTMLElement>();
  const width = containerRect.width;
  const visibleLimit = width >= 960 ? 7 : width >= 600 ? 4 : 3;
  const shouldCollapse = items.length > visibleLimit;
  const shouldShowRoot = shouldCollapse && width >= 600;
  const firstItem = shouldShowRoot ? items[0] : undefined;
  const currentItem = items.at(-1);
  const trailingCount = 2;
  const trailingItems = shouldCollapse ? items.slice(-trailingCount) : items;
  const hiddenItems = shouldCollapse ? items.slice(shouldShowRoot ? 1 : 0, -trailingCount) : [];
  const menuLabel = `Показать родительские страницы (${hiddenItems.length})`;

  return (
    <nav
      {...rootAttrs}
      ref={containerRef}
      aria-label={label}
      className={clsx(styles.root, embedded && styles._embedded, className)}
    >
      <Breadcrumbs
        separator={<ChevronRight size={13} aria-hidden="true" />}
        separatorMargin={4}
        classNames={{ root: styles.trail, separator: styles.separator, breadcrumb: styles.crumb }}
      >
        {isDefined(firstItem) && <BreadcrumbItem item={firstItem} />}
        {shouldCollapse && (
          <div className={styles.overflow}>
            <Menu
              position="bottom-start"
              withinPortal={false}
              width={320}
              menuItemTabIndex={0}
              withInitialFocusPlaceholder={false}
            >
              <Menu.Target>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size={32}
                  aria-label={menuLabel}
                  title="Родительские страницы"
                >
                  <Ellipsis size={18} aria-hidden="true" />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown className={styles.dropdown}>
                <Menu.Label>Родительские страницы</Menu.Label>
                {hiddenItems.map((item) => (
                  <BreadcrumbItem key={item.id} item={item} inMenu />
                ))}
              </Menu.Dropdown>
            </Menu>
          </div>
        )}
        {trailingItems.map((item) => (
          <BreadcrumbItem key={item.id} item={item} isCurrent={item === currentItem} />
        ))}
      </Breadcrumbs>
    </nav>
  );
};
