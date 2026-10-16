import { useComputedColorScheme, useMantineColorScheme } from "@mantine/core";

/** Выбранная схема, её действующее значение и управление выбором. */
type ThemeColorScheme = ReturnType<typeof useMantineColorScheme> & {
  /** Действующая схема: при выборе «auto» — системная светлая или тёмная. */
  computedColorScheme: "light" | "dark";
};

/**
 * Предоставляет выбор светлой, тёмной либо системной схемы владельцу переключателя
 * и действующую схему, чтобы переключатель предлагал противоположную видимой.
 */
export const useThemeColorScheme = (): ThemeColorScheme => {
  const scheme = useMantineColorScheme();
  const computedColorScheme = useComputedColorScheme("light", {
    getInitialValueInEffect: false,
  });
  return { ...scheme, computedColorScheme };
};
