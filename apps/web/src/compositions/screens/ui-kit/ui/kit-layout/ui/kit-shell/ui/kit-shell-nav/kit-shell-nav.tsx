import { useId, useState } from "react";
import type { MouseEvent } from "react";
import clsx from "clsx";
import { NavLink } from "@mantine/core";
import { Box } from "lucide-react";
import { SHELL_PRODUCT_ITEMS, SHELL_TOP_ITEMS, SHELL_WORK_ITEMS } from "../../config/shell.config";
import type { KitShellNavProps } from "./types/kit-shell-nav-props.type";
import styles from "./styles/kit-shell-nav.module.css";

/**
 * Навигация примера каркаса: те же NavLink, роли и состояния, что у разделов проекта,
 * на демонстрационных пунктах. Выбор меняет текущий пункт без перехода по адресу.
 *
 * Используется для:
 *  - сайдбара и Drawer композиционного примера галереи
 */
export const KitShellNav = (props: KitShellNavProps) => {
  const { currentId, onSelect, className, ...rootAttrs } = props;
  const productGroupId = useId();
  const isProductCurrent = SHELL_PRODUCT_ITEMS.some((item) => item.id === currentId);
  // Группа текущего раздела раскрыта, пока человек сам не свернул или не раскрыл её.
  const [productChoice, setProductOpened] = useState<boolean | null>(null);
  const isProductOpened = productChoice ?? isProductCurrent;
  const select = (id: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    onSelect(id);
  };
  const getCurrent = (id: string) => (id === currentId ? "page" : undefined);

  return (
    <nav {...rootAttrs} className={clsx(styles.root, className)} aria-label="Разделы примера">
      {SHELL_TOP_ITEMS.map((item) => (
        <NavLink
          key={item.id}
          component="a"
          href="#kit-shell"
          label={item.label}
          leftSection={<item.Icon size={17} aria-hidden="true" />}
          aria-current={getCurrent(item.id)}
          onClick={select(item.id)}
        />
      ))}
      <NavLink
        component="button"
        type="button"
        label="Продукт"
        leftSection={<Box size={17} aria-hidden="true" />}
        mod={{ "current-group": isProductCurrent }}
        opened={isProductOpened}
        onChange={setProductOpened}
        childrenOffset={0}
        keepMounted={false}
        aria-expanded={isProductOpened}
        aria-controls={productGroupId}
      >
        <div id={productGroupId} className={styles.group} role="group" aria-label="Продукт">
          {SHELL_PRODUCT_ITEMS.map((item) => (
            <NavLink
              key={item.id}
              component="a"
              href="#kit-shell"
              label={item.label}
              leftSection={<item.Icon size={15} aria-hidden="true" />}
              aria-current={getCurrent(item.id)}
              mod={{ nested: true }}
              onClick={select(item.id)}
            />
          ))}
        </div>
      </NavLink>
      {SHELL_WORK_ITEMS.map((item) => (
        <NavLink
          key={item.id}
          component="a"
          href="#kit-shell"
          label={item.label}
          leftSection={<item.Icon size={17} aria-hidden="true" />}
          aria-current={getCurrent(item.id)}
          mod={{ "group-start": item.isGroupStart }}
          onClick={select(item.id)}
        />
      ))}
    </nav>
  );
};
