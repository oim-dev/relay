import {
  ActionIcon,
  Autocomplete,
  Button,
  createTheme,
  defaultVariantColorsResolver,
  Input,
  InputBase,
  Modal,
  NativeSelect,
  NumberInput,
  Progress,
  Select,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core";
import type { CSSVariablesResolver } from "@mantine/core";

/**
 * Согласует поверхности Mantine с графитовой палитрой и контрастом нейтральных действий.
 */
export const themeVariables: CSSVariablesResolver = () => ({
  variables: {
    "--mantine-color-dimmed": "var(--tasks-muted)",
    "--mantine-color-text": "var(--tasks-ink)",
    "--mantine-color-body": "var(--tasks-surface)",
    "--mantine-color-default": "var(--tasks-surface)",
    "--mantine-color-default-hover": "var(--tasks-subtle)",
    "--mantine-color-default-color": "var(--tasks-ink)",
    "--mantine-color-default-border": "var(--tasks-border)",
    "--mantine-color-anchor": "var(--tasks-ink)",
    "--mantine-color-placeholder": "var(--tasks-soft)",
  },
  light: {
    "--mantine-color-error": "var(--mantine-color-red-8)",
    "--mantine-primary-color-contrast": "var(--mantine-color-white)",
    "--mantine-color-gray-filled": "var(--mantine-color-gray-8)",
    "--mantine-color-gray-filled-hover": "var(--mantine-color-gray-9)",
    "--mantine-color-gray-text": "var(--mantine-color-gray-8)",
    "--mantine-color-gray-light-color": "var(--mantine-color-gray-8)",
  },
  dark: {
    "--mantine-color-error": "var(--mantine-color-red-4)",
    "--mantine-primary-color-contrast": "var(--mantine-color-gray-9)",
    "--mantine-color-gray-filled": "var(--mantine-color-gray-2)",
    "--mantine-color-gray-text": "var(--mantine-color-gray-1)",
    "--mantine-color-gray-light-color": "var(--mantine-color-gray-1)",
    "--mantine-color-gray-filled-hover": "var(--mantine-color-gray-1)",
  },
});

/** Спокойная, компактная тема для длительной работы с текстом. */
export const theme = createTheme({
  primaryColor: "gray",
  primaryShade: 6,
  autoContrast: true,
  // Цвет текста заливки меняется вместе со схемой, а не вычисляется один раз по светлой палитре.
  variantColorResolver: (input) => {
    const colors = defaultVariantColorsResolver(input);
    if (input.color === "orange" && input.variant === "light") {
      return { ...colors, color: "var(--tasks-warning-ink)" };
    }
    if (input.color === "gray" && input.variant === "filled") {
      return { ...colors, color: "var(--mantine-primary-color-contrast)" };
    }
    return colors;
  },
  defaultRadius: "md",
  fontFamily: "Inter Variable, Inter, system-ui, sans-serif",
  fontFamilyMonospace: "ui-monospace, SFMono-Regular, Consolas, monospace",
  headings: { fontFamily: "Inter Variable, Inter, system-ui, sans-serif", fontWeight: "650" },
  fontSizes: { xs: "0.75rem", sm: "0.8125rem", md: "0.875rem", lg: "1rem", xl: "1.125rem" },
  radius: { xs: "0.25rem", sm: "0.375rem", md: "0.5rem", lg: "0.75rem", xl: "1rem" },
  // Единственный источник примитивных палитр: семантические роли в styles/variables.css
  // ссылаются на них через --mantine-color-*, компоненты используют только роли --tasks-*.
  colors: {
    // Нейтральная светлая шкала с лёгким розовым оттенком холста.
    gray: [
      "#f7f5f6",
      "#f2f0f1",
      "#e5e2e4",
      "#d0cccf",
      "#b1adb2",
      "#8e8a8f",
      "#6e6b71",
      "#626166",
      "#343236",
      "#191919",
    ],
    dark: [
      "#f6f4f5",
      "#d9d6da",
      "#b8b5bb",
      "#9d9aa2",
      "#5c5a60",
      "#3a383d",
      "#2a292d",
      "#202023",
      "#1a1a1d",
      "#141416",
    ],
    teal: [
      "#f1f8f3",
      "#e4efe7",
      "#c9dfcf",
      "#aac6b4",
      "#8aaf98",
      "#709a80",
      "#547c62",
      "#42634f",
      "#34503f",
      "#293e32",
    ],
    // Акцент Relay: светлая тема использует оттенок 6, тёмная — 4.
    rose: [
      "#fff0f4",
      "#ffe0e8",
      "#fbc0d1",
      "#ff9ab6",
      "#ff719a",
      "#ee4a7a",
      "#d8255b",
      "#b81c4c",
      "#93163d",
      "#6d102d",
    ],
    // Положительное состояние и фактическое выполнение.
    jade: [
      "#eef8f2",
      "#d9efe2",
      "#b3dfc6",
      "#8ad1ab",
      "#6bc59b",
      "#44a67a",
      "#328b64",
      "#287754",
      "#1f5e42",
      "#164431",
    ],
  },
  components: {
    Button: Button.extend({ defaultProps: { size: "sm", fw: 550 } }),
    ActionIcon: ActionIcon.extend({ defaultProps: { size: 32, variant: "subtle", color: "gray" } }),
    Input: Input.extend({ defaultProps: { size: "sm" } }),
    InputBase: InputBase.extend({ defaultProps: { size: "sm" } }),
    TextInput: TextInput.extend({ defaultProps: { size: "sm" } }),
    Textarea: Textarea.extend({ defaultProps: { size: "sm" } }),
    Select: Select.extend({ defaultProps: { size: "sm" } }),
    NativeSelect: NativeSelect.extend({ defaultProps: { size: "sm" } }),
    NumberInput: NumberInput.extend({ defaultProps: { size: "sm" } }),
    Autocomplete: Autocomplete.extend({ defaultProps: { size: "sm" } }),
    Progress: Progress.extend({ defaultProps: { color: "var(--tasks-muted)" } }),
    Tooltip: Tooltip.extend({ defaultProps: { withArrow: true, openDelay: 400 } }),
    Modal: Modal.extend({
      defaultProps: {
        centered: true,
        radius: "lg",
        overlayProps: { backgroundOpacity: 0.3, blur: 2 },
      },
    }),
  },
});
