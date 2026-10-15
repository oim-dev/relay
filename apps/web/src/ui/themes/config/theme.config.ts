import {
  ActionIcon,
  Alert,
  Anchor,
  Autocomplete,
  Badge,
  Button,
  Checkbox,
  CloseButton,
  Combobox,
  createTheme,
  DEFAULT_THEME,
  defaultVariantColorsResolver,
  Drawer,
  Group,
  Input,
  InputBase,
  InputWrapper,
  Menu,
  Modal,
  NativeSelect,
  NavLink,
  Notification,
  NumberInput,
  Pill,
  PillGroup,
  Popover,
  Progress,
  Select,
  Skeleton,
  Tabs,
  TagsInput,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core";
import type { MantineColorsTuple } from "@mantine/core";
import controlClasses from "../styles/controls.module.css";
import navigationClasses from "../styles/navigation.module.css";
import progressClasses from "../styles/progress.module.css";
import { TONE_PALETTES } from "./color-roles.config";

const FONT_FAMILY = "Inter Variable, Inter, system-ui, sans-serif";

/** Нейтральная светлая шкала с лёгким розовым оттенком холста. */
const gray: MantineColorsTuple = [
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
];

/** Акцент Relay — ультрамарин: светлая тема использует оттенок 6 (#3e5bff), тёмная — 4. */
const ultramarine: MantineColorsTuple = [
  "#eef1ff",
  "#dfe4ff",
  "#bdc8ff",
  "#98a9ff",
  "#7a8fff",
  "#5d75ff",
  "#3e5bff",
  "#2f47e0",
  "#2537b3",
  "#1b2a85",
];

/** Положительное состояние и фактическое выполнение. */
const jade: MantineColorsTuple = [
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
];

const TONE_NAMES = new Set<string>(Object.values(TONE_PALETTES).flat());

/** Высота бейджа с подписью 12px; крупные размеры сохраняют значения Mantine. */
const BADGE_HEIGHTS: Partial<Record<string, string>> = {
  xs: "1.125rem",
  sm: "1.25rem",
  md: "1.375rem",
};

/** Спокойная тема для длительной работы с текстом: роли и шкалы — в ui/themes. */
export const theme = createTheme({
  primaryColor: "gray",
  primaryShade: 6,
  autoContrast: true,
  // Переходы Modal, Drawer, Menu и Tooltip отключаются при prefers-reduced-motion.
  respectReducedMotion: true,
  // Текст на заливке меняется вместе со схемой: роли дают светлую заливку в тёмной теме.
  variantColorResolver: (input) => {
    const colors = defaultVariantColorsResolver(input);
    const color = input.color ?? "";
    if (input.variant === "filled" && color === "gray") {
      return { ...colors, color: "var(--tasks-action-primary-text)" };
    }
    if (input.variant === "filled" && TONE_NAMES.has(color)) {
      const contrast =
        color === "accent" || color === "ultramarine"
          ? "var(--tasks-accent-contrast)"
          : "var(--tasks-status-contrast)";
      return { ...colors, color: contrast };
    }
    return colors;
  },
  defaultRadius: "md",
  fontFamily: FONT_FAMILY,
  fontFamilyMonospace: "ui-monospace, SFMono-Regular, Consolas, monospace",
  headings: {
    fontFamily: FONT_FAMILY,
    fontWeight: "700",
    sizes: {
      h1: { fontSize: "var(--tasks-font-size-page-title)", lineHeight: "1.15" },
      h2: { fontSize: "var(--tasks-font-size-panel-title)", lineHeight: "1.25" },
      h3: { fontSize: "var(--tasks-font-size-panel-title)", lineHeight: "1.25" },
      h4: {
        fontSize: "var(--tasks-font-size-record-title)",
        lineHeight: "1.35",
        fontWeight: "650",
      },
      h5: { fontSize: "0.875rem", lineHeight: "1.4", fontWeight: "650" },
      h6: { fontSize: "0.8125rem", lineHeight: "1.4", fontWeight: "650" },
    },
  },
  // Компактная подпись 12, вспомогательный 13, основной интерфейс 14 (docs/DESIGN_SYSTEM.md).
  fontSizes: { xs: "0.75rem", sm: "0.8125rem", md: "0.875rem", lg: "1rem", xl: "1.125rem" },
  lineHeights: { xs: "1.4", sm: "1.45", md: "1.5", lg: "1.5", xl: "1.4" },
  // Шкала расстояний 4–48px; совпадает с --tasks-space-* в styles/variables.css.
  spacing: { xs: "0.5rem", sm: "0.75rem", md: "1rem", lg: "1.25rem", xl: "2rem" },
  // Те же пороги, что @custom-media в styles/media.css: 480, 768, 1024, 1200, 1440px.
  breakpoints: { xs: "30em", sm: "48em", md: "64em", lg: "75em", xl: "90em" },
  // Контрол 8, компактный контейнер 12, строка 16; крупные радиусы — роли --tasks-radius-*.
  radius: { xs: "0.25rem", sm: "0.375rem", md: "0.5rem", lg: "0.75rem", xl: "1rem" },
  // Единственный источник примитивных палитр. Смысловые имена состояний и акцента —
  // те же палитры; их виртуальные цвета связывает с ролями config/color-roles.config.ts.
  colors: {
    gray,
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
    ultramarine,
    jade,
    accent: ultramarine,
    success: jade,
    danger: DEFAULT_THEME.colors.red,
    warning: DEFAULT_THEME.colors.orange,
    info: DEFAULT_THEME.colors.blue,
  },
  components: {
    Button: Button.extend({ defaultProps: { size: "sm", fw: 550 } }),
    // Нейтральная иконка-действие ведёт себя как контрол навигации: покой muted, наведение —
    // nav-hover и ink, текущее место (variant="light") — заливка и цвет текущего пункта.
    // Раскрытие и текущее место дополнительно отмечены контуром (controls.module.css).
    ActionIcon: ActionIcon.extend({
      defaultProps: { size: 32, variant: "subtle", color: "gray" },
      classNames: { root: controlClasses.iconAction },
      vars: (_theme, props) => {
        const isNeutral = props.color === undefined || props.color === "gray";
        if (isNeutral && props.variant === "subtle") {
          return {
            root: {
              "--ai-color": "var(--tasks-muted)",
              "--ai-hover": "var(--tasks-nav-hover)",
              "--ai-hover-color": "var(--tasks-ink)",
            },
          };
        }
        if (isNeutral && props.variant === "light") {
          return {
            root: {
              "--ai-bg": "var(--tasks-nav-current-surface)",
              "--ai-color": "var(--tasks-nav-current-ink)",
              "--ai-hover": "var(--tasks-nav-current-surface)",
              "--ai-hover-color": "var(--tasks-nav-current-ink)",
            },
          };
        }
        return { root: {} };
      },
    }),
    // Крестик закрытия — у Modal, Drawer, Alert, Notification и в потребителях — получает
    // ту же область нажатия 44px на touch, что ActionIcon (controls.module.css).
    CloseButton: CloseButton.extend({ classNames: { root: controlClasses.closeButton } }),
    // Соседние ActionIcon в Group на touch разводятся с учётом gap группы (controls.module.css).
    Group: Group.extend({ classNames: { root: controlClasses.group } }),
    Input: Input.extend({
      defaultProps: { size: "sm" },
      classNames: { input: controlClasses.field },
    }),
    // Кнопка очистки поля (clearable) рендерит CloseButton под собственным именем Styles API.
    InputClearButton: Input.ClearButton.extend({
      classNames: { root: controlClasses.closeButton },
    }),
    InputWrapper: InputWrapper.extend({
      classNames: { description: controlClasses.fieldNote, error: controlClasses.fieldError },
    }),
    InputBase: InputBase.extend({ defaultProps: { size: "sm" } }),
    TextInput: TextInput.extend({ defaultProps: { size: "sm" } }),
    Textarea: Textarea.extend({ defaultProps: { size: "sm" } }),
    // variant="navigation" — компактный выбор в навигации каркаса (выбор проекта).
    Select: Select.extend({
      defaultProps: { size: "sm" },
      classNames: (_theme, props) =>
        props.variant === "navigation"
          ? {
              root: navigationClasses.select,
              input: navigationClasses.selectInput,
              option: controlClasses.option,
            }
          : { option: controlClasses.option },
    }),
    // Пункт навигации на общей подложке: единые правила каркаса и примеров галереи.
    NavLink: NavLink.extend({
      classNames: {
        root: navigationClasses.link,
        label: navigationClasses.linkLabel,
        section: navigationClasses.linkSection,
        children: navigationClasses.linkChildren,
      },
    }),
    NativeSelect: NativeSelect.extend({ defaultProps: { size: "sm" } }),
    NumberInput: NumberInput.extend({ defaultProps: { size: "sm" } }),
    Autocomplete: Autocomplete.extend({
      defaultProps: { size: "sm" },
      classNames: { option: controlClasses.option },
    }),
    TagsInput: TagsInput.extend({ classNames: { option: controlClasses.option } }),
    // Выбор записи — акцент; галочка контрастна заливке в обеих схемах.
    Checkbox: Checkbox.extend({
      defaultProps: { size: "sm", color: "accent", iconColor: "var(--tasks-accent-contrast)" },
      classNames: { input: controlClasses.checkbox },
    }),
    // Значимая подпись бейджа не меньше 12px и без принудительного верхнего регистра.
    // Явный color по умолчанию: без него Mantine берёт белый текст из CSS, а нейтральная
    // заливка в тёмной схеме светлая; с color текст — action-primary-text из резолвера.
    Badge: Badge.extend({
      defaultProps: { radius: "xl", tt: "none", fw: 600, color: "gray" },
      vars: (_theme, props) => {
        const height = BADGE_HEIGHTS[typeof props.size === "string" ? props.size : "md"];
        return {
          root: {
            "--badge-fz": height === undefined ? undefined : "0.75rem",
            "--badge-height": height,
          },
        };
      },
    }),
    // Выбранный вариант списка: текст контрастен нейтральной заливке в обеих схемах.
    Combobox: Combobox.extend({ classNames: { option: controlClasses.option } }),
    Alert: Alert.extend({ defaultProps: { variant: "light", radius: "lg" } }),
    // Ссылка — акцент; в читаемом тексте потребитель задаёт underline="always".
    Anchor: Anchor.extend({ classNames: { root: controlClasses.anchor } }),
    Menu: Menu.extend({
      defaultProps: { radius: "lg", shadow: "md", transitionProps: { duration: 140 } },
      classNames: { item: controlClasses.menuItem },
    }),
    // На touch плашка и её крестик крупнее, а зазор между плашками вмещает область
    // нажатия крестика 44px без перекрытия соседей (controls.module.css).
    Pill: Pill.extend({
      classNames: { root: controlClasses.pill, remove: controlClasses.pillRemove },
    }),
    PillGroup: PillGroup.extend({ classNames: { group: controlClasses.pillGroup } }),
    Popover: Popover.extend({ defaultProps: { radius: "lg", shadow: "md" } }),
    // Текущий раздел — акцент, как текущее место навигации.
    Tabs: Tabs.extend({ defaultProps: { color: "accent" } }),
    Modal: Modal.extend({
      defaultProps: {
        centered: true,
        radius: "xl",
        overlayProps: { backgroundOpacity: 0.3, blur: 2 },
        transitionProps: { duration: 200 },
      },
    }),
    // Кнопка закрытия окна без подписи получает доступное имя; потребитель может уточнить
    // его через closeButtonProps (например, «Закрыть навигацию»).
    ModalCloseButton: Modal.CloseButton.extend({ defaultProps: { "aria-label": "Закрыть" } }),
    DrawerCloseButton: Drawer.CloseButton.extend({ defaultProps: { "aria-label": "Закрыть" } }),
    // variant="navigation" — выдвижная навигация каркаса на узком экране.
    Drawer: Drawer.extend({
      defaultProps: {
        overlayProps: { backgroundOpacity: 0.3 },
        transitionProps: { duration: 200 },
      },
      classNames: (_theme, props) =>
        props.variant === "navigation"
          ? {
              content: navigationClasses.drawerContent,
              header: navigationClasses.drawerHeader,
              title: navigationClasses.drawerTitle,
            }
          : {},
    }),
    Notification: Notification.extend({ defaultProps: { radius: "lg", withBorder: true } }),
    Skeleton: Skeleton.extend({ defaultProps: { radius: "md" } }),
    Progress: Progress.extend({
      defaultProps: { color: "var(--tasks-muted)" },
      // Акцентный вариант: общий вид полос прогресса и величин на ролях темы.
      classNames: (_theme, props) =>
        props.variant === "accent"
          ? { root: progressClasses.accentRoot, section: progressClasses.accentSection }
          : {},
    }),
    Tooltip: Tooltip.extend({
      defaultProps: { withArrow: true, openDelay: 400, radius: "md", multiline: true, maw: 320 },
    }),
  },
});
