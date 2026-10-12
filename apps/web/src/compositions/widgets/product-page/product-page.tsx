import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { PageHeader } from "ui/page-header";
import { PageStage } from "ui/page-stage";
import { isDefined } from "shared/value-predicates";
import type { ProductPageProps } from "./types/product-page-props.type";
import styles from "./styles/product-page.module.css";

/**
 * Размещает страницу продукта на общей сцене: шапка с контекстом и действиями, затем содержание.
 * При входе объявляет страницу фокусом на заголовке или переходит к разделу из адреса.
 *
 * Используется для:
 *  - каталогов, карточек и редакторов паспорта, фич, сценариев и приложений
 */
export const ProductPage = (props: ProductPageProps) => {
  const {
    children,
    title,
    description,
    meta,
    actions,
    actionsLayout = "inline",
    ...rootAttrs
  } = props;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const location = useLocation();
  const shownDescription = description === "" ? undefined : description;
  const shownMeta = isDefined(meta) ? <span className={styles.meta}>{meta}</span> : undefined;
  useEffect(() => {
    document.title = `${title} · Relay`;
    const target = document.getElementById(location.hash.slice(1));
    if (target !== null) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "start" });
      return;
    }
    headingRef.current?.focus({ preventScroll: true });
  }, [location.pathname, location.hash, title]);
  return (
    <PageStage {...rootAttrs}>
      <PageHeader
        title={title}
        titleRef={headingRef}
        meta={shownMeta}
        description={shownDescription}
        actions={actions}
        actionsLayout={actionsLayout}
      />
      {children}
    </PageStage>
  );
};
