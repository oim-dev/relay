import { getDefaultZIndex, MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { themeVariables } from "../../config/color-roles.config";
import { theme } from "../../config/theme.config";
import type { ThemeProviderProps } from "./types/theme-provider-props.type";
import "../../styles/index.css";

/**
 * Подключает визуальную систему Relay и цветовые схемы.
 *
 * Используется для:
 *  - согласованного оформления экранов, диалогов и уведомлений
 *
 * Слои: содержимое и sticky-каркас ниже модальных окон Mantine, выпадающие списки
 * над окнами (в том числе внутри диалога), уведомления — над всеми окнами.
 */
export const ThemeProvider = (props: ThemeProviderProps) => {
  return (
    <MantineProvider theme={theme} cssVariablesResolver={themeVariables} defaultColorScheme="auto">
      <Notifications position="bottom-right" limit={3} zIndex={getDefaultZIndex("max")} />
      {props.children}
    </MantineProvider>
  );
};
