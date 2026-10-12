import { useEffect, useState } from "react";
import { isMantineColorScheme, SegmentedControl, Switch } from "@mantine/core";
import { PageHeader } from "ui/page-header";
import { PageStage } from "ui/page-stage";
import { useThemeColorScheme } from "ui/themes";
import { KitColors } from "./ui/kit-colors/kit-colors";
import { KitContent } from "./ui/kit-content/kit-content";
import { KitControls } from "./ui/kit-controls/kit-controls";
import { KitFeedback } from "./ui/kit-feedback/kit-feedback";
import { KitOverlays } from "./ui/kit-overlays/kit-overlays";
import { KitPanels } from "./ui/kit-panels/kit-panels";
import styles from "./styles/ui-kit.module.css";

const SCHEME_OPTIONS = [
  { value: "light", label: "Светлая" },
  { value: "dark", label: "Тёмная" },
  { value: "auto", label: "Системная" },
];

/**
 * Галерея UI kit для разработки: реальные компоненты и тема на демонстрационных данных.
 * Подключается только в dev-сборке и не требует Server.
 *
 * Используется для:
 *  - справки о ролях, контролах, панелях и состояниях с правилами выбора
 *  - браузерной приёмки тем, ширин, клавиатуры и отключённого декора
 */
export const UiKitScreen = () => {
  const { colorScheme, setColorScheme } = useThemeColorScheme();
  const [isDecorOff, setDecorOff] = useState(false);
  const decorState = isDecorOff ? "off" : "on";
  useEffect(() => {
    document.title = "Галерея UI kit · Relay";
  }, []);
  return (
    <PageStage className={styles.root} data-decor={decorState}>
      <PageHeader
        meta="Только для разработки"
        title="Галерея UI kit"
        description="Роли темы, контролы Mantine и общие компоненты ui в обеих схемах. Каждый пример указывает назначение, импорт и правило выбора."
        actionsLayout="toolbar"
        actions={
          <>
            <SegmentedControl
              aria-label="Цветовая схема"
              data={SCHEME_OPTIONS}
              value={colorScheme}
              onChange={(value) => {
                if (isMantineColorScheme(value)) setColorScheme(value);
              }}
            />
            <Switch
              label="Отключить декор"
              checked={isDecorOff}
              onChange={(event) => setDecorOff(event.currentTarget.checked)}
            />
          </>
        }
      />
      <KitColors />
      <KitControls />
      <KitPanels />
      <KitFeedback />
      <KitOverlays />
      <KitContent />
    </PageStage>
  );
};
