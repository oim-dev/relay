import type { CSSVariablesResolver, MantineColorsTuple, MantineTheme } from "@mantine/core";
import { mixSrgb, withAlpha } from "../helpers/srgb-color";

/**
 * Палитра и оттенки акцента Relay. Смена акцента — правка только этой записи
 * или палитры `ultramarine`: все производные роли пересчитываются резолвером.
 */
const ACCENT = { palette: "ultramarine", lightShade: 6, darkShade: 4 } as const;

const WHITE = "#ffffff";
const BLACK = "#000000";

/**
 * Значения одной роли для светлой и тёмной схемы.
 */
type SchemePair = readonly [light: string, dark: string];

/**
 * Палитры Mantine, из которых выводятся роли.
 */
type Palettes = MantineTheme["colors"];

/**
 * Имена палитр Mantine, которые обозначают состояние, и их роль. Прямые выборы
 * `color="red"` и аналогичные в старых экранах получают значения ролей, а новые
 * экраны используют смысловые имена `danger`, `warning`, `success`, `info`, `accent`.
 */
export const TONE_PALETTES = {
  danger: ["danger", "red"],
  warning: ["warning", "orange", "yellow"],
  success: ["success", "jade", "green", "teal"],
  info: ["info", "blue"],
  accent: ["accent", "ultramarine"],
} as const;

/**
 * Смысловая роль состояния или акцента.
 */
type Tone = keyof typeof TONE_PALETTES;

/**
 * Возвращает палитру темы; отсутствие собственной палитры — ошибка конфигурации.
 */
const requirePalette = (colors: Palettes, name: string): MantineColorsTuple => {
  const palette = colors[name];
  if (palette === undefined) {
    throw new Error(`В теме нет палитры ${name}, нужной цветовым ролям`);
  }
  return palette;
};

/**
 * Вычисляет цветовые роли `--tasks-*` для обеих схем из палитр темы.
 *
 * Все значения — конкретные sRGB hex/rgba и градиенты из них: прикладные роли не зависят
 * от `light-dark()` и `color-mix()`, а схему по-прежнему выбирает Mantine.
 */
const buildColorRoles = (colors: Palettes): Record<string, SchemePair> => {
  const { gray, dark, orange, red, blue, grape, cyan } = colors;
  const jade = requirePalette(colors, "jade");
  const accentPalette = requirePalette(colors, ACCENT.palette);
  const accent: SchemePair = [accentPalette[ACCENT.lightShade], accentPalette[ACCENT.darkShade]];
  const ink: SchemePair = [gray[9], dark[0]];
  // Слабый текст читаем на панели, внешнем фоне и градиенте главной панели (≥4.5:1).
  const soft: SchemePair = [mixSrgb(gray[6], 85, gray[8]), mixSrgb(dark[3], 70, dark[2])];
  const tile: SchemePair = [WHITE, dark[6]];
  const card: SchemePair = [mixSrgb(gray[1], 55, gray[2]), dark[7]];
  const inverse: SchemePair = [WHITE, dark[9]];
  const accentHover: SchemePair = [mixSrgb(accent[0], 85, BLACK), mixSrgb(accent[1], 70, WHITE)];
  const accentSubtle: SchemePair = [mixSrgb(accent[0], 7, WHITE), mixSrgb(accent[1], 16, dark[7])];
  const success: SchemePair = [jade[7], jade[4]];
  const warning: SchemePair = [mixSrgb(orange[9], 82, BLACK), orange[3]];
  const danger: SchemePair = [red[9], red[4]];
  const info: SchemePair = [blue[9], blue[4]];
  const actionPrimary: SchemePair = [gray[8], gray[2]];

  // Главная карточка: спокойный переход от тона акцента к холодному бирюзовому, 155deg.
  const featureStart: SchemePair = [mixSrgb(accent[0], 11, WHITE), mixSrgb(accent[1], 16, dark[7])];
  const featureEnd: SchemePair = [mixSrgb(cyan[1], 45, gray[2]), mixSrgb(cyan[4], 16, dark[7])];
  const featureSurface: SchemePair = [
    mixSrgb(featureStart[0], 50, featureEnd[0]),
    mixSrgb(featureStart[1], 50, featureEnd[1]),
  ];
  const featureImage = (scheme: 0 | 1) =>
    `linear-gradient(155deg, ${featureStart[scheme]} 0%, ${featureEnd[scheme]} 100%)`;
  const hatchStripe: SchemePair = [withAlpha(ink[0], 0.07), withAlpha(ink[1], 0.09)];
  const hatchImage = (scheme: 0 | 1) =>
    `repeating-linear-gradient(-45deg, ${hatchStripe[scheme]} 0 0.25rem, ${withAlpha(ink[scheme], 0)} 0.25rem 0.625rem)`;
  // Затухание — прозрачный вариант того же конечного цвета, без перехода через серый.
  const fadeImage = (color: string) =>
    `linear-gradient(to bottom, ${withAlpha(color, 0)}, ${color})`;

  const accentContrast: SchemePair = [WHITE, dark[9]];
  const statusSurface = (light: string, darkTint: string): SchemePair => [
    light,
    mixSrgb(darkTint, 12, dark[7]),
  ];
  const progressTrack: SchemePair = [
    mixSrgb(accent[0], 22, WHITE),
    mixSrgb(accent[1], 18, dark[6]),
  ];
  const tones: Record<Tone, { fill: SchemePair; surface: SchemePair; border: SchemePair }> = {
    danger: { fill: danger, surface: statusSurface(red[0], red[4]), border: [red[4], red[8]] },
    warning: {
      fill: warning,
      surface: statusSurface(orange[0], orange[4]),
      border: [orange[4], orange[8]],
    },
    success: {
      fill: success,
      surface: statusSurface(jade[0], jade[4]),
      border: [jade[3], jade[7]],
    },
    info: { fill: info, surface: statusSurface(blue[0], blue[4]), border: [blue[3], blue[8]] },
    accent: { fill: accent, surface: accentSubtle, border: progressTrack },
  };
  // Наведение на заливку и светлую подложку состояния — тоже конкретные sRGB-значения.
  const toneHovers: Record<string, SchemePair> = {};
  for (const [tone, { fill, surface, border }] of Object.entries(tones)) {
    toneHovers[`tone-${tone}-filled-hover`] = [
      mixSrgb(fill[0], 85, BLACK),
      mixSrgb(fill[1], 80, WHITE),
    ];
    toneHovers[`tone-${tone}-light-hover`] = [
      mixSrgb(surface[0], 60, border[0]),
      mixSrgb(surface[1], 60, border[1]),
    ];
  }

  return {
    ...toneHovers,
    // Поверхности: холст, шапка, основные и вложенные панели.
    canvas: [gray[1], dark[9]],
    chrome: [WHITE, dark[8]],
    surface: [WHITE, dark[7]],
    raised: [WHITE, dark[6]],
    "surface-quiet": [gray[0], dark[8]],
    subtle: [gray[0], dark[6]],
    border: [gray[2], dark[5]],
    "border-strong": [gray[5], dark[3]],
    selected: [gray[1], dark[5]],
    "selected-border": [gray[6], dark[3]],

    // Уровни экрана-дашборда от дальнего к ближнему.
    backdrop: [gray[2], mixSrgb(dark[9], 60, BLACK)],
    stage: [mixSrgb(gray[0], 45, WHITE), dark[9]],
    card,
    tile,
    "tile-hover": [gray[0], dark[5]],
    "tile-border": [gray[2], dark[5]],
    "tile-translucent": [withAlpha(tile[0], 0.55), withAlpha(tile[1], 0.55)],

    // Декор: сплошная основа и отдельные image-слои. Смысл не зависит от изображений.
    "feature-surface": featureSurface,
    "feature-image": [featureImage(0), featureImage(1)],
    "feature-fade-image": [fadeImage(featureSurface[0]), fadeImage(featureSurface[1])],
    "hatch-surface": [WHITE, dark[7]],
    "hatch-image": [hatchImage(0), hatchImage(1)],
    "card-fade-image": [fadeImage(card[0]), fadeImage(card[1])],

    // Подложки иконок показателей.
    "icon-chip-highlight": [withAlpha(accentContrast[0], 0.18), withAlpha(accentContrast[1], 0.18)],
    "icon-chip-hatch": [withAlpha(ink[0], 0.08), withAlpha(ink[1], 0.08)],
    "icon-chip-inverse": [withAlpha(inverse[0], 0.14), withAlpha(inverse[1], 0.14)],

    // Текст.
    ink,
    muted: [gray[7], dark[2]],
    soft,

    // Инверсная поверхность для одного главного сигнала экрана.
    "inverse-surface": [gray[9], dark[0]],
    inverse,
    "inverse-muted": [gray[3], dark[5]],
    "inverse-accent": [mixSrgb(accent[0], 70, WHITE), mixSrgb(accent[1], 60, BLACK)],

    // Акцент Relay и его производные.
    accent,
    "accent-hover": accentHover,
    "accent-ink": accentHover,
    "accent-subtle": accentSubtle,
    "accent-contrast": accentContrast,

    // Действия: нейтральное главное действие и недоступное состояние.
    "action-primary": actionPrimary,
    "action-primary-hover": [gray[9], gray[1]],
    "action-primary-text": [WHITE, gray[9]],
    // Текст нейтральных вариантов Mantine `color="gray"`.
    "neutral-text": [gray[8], gray[1]],
    "action-disabled": [gray[1], dark[6]],
    "action-disabled-text": [gray[6], dark[3]],
    "action-disabled-border": [gray[2], dark[5]],

    // Граница поля и неотмеченного checkbox: значимая граница контрола, не менее 3:1
    // к обоим соседям — заливке поля и панели (card), а также к сцене и фону.
    // Светлая: 4.0 к заливке поля, 3.34 к card, 3.11 к backdrop; тёмная: 5.21 и 5.86.
    "field-border": [mixSrgb(gray[5], 60, gray[6]), dark[3]],

    // Состояния: текст и индикатор, фон, рамка; текст на заливке состояния.
    success,
    "success-surface": tones.success.surface,
    "success-border": [jade[3], jade[7]],
    warning,
    "warning-surface": tones.warning.surface,
    "warning-border": [orange[4], orange[8]],
    danger,
    "danger-surface": tones.danger.surface,
    "danger-border": [red[4], red[8]],
    info,
    "info-surface": tones.info.surface,
    "info-border": [blue[3], blue[8]],
    "status-contrast": [WHITE, dark[9]],

    // Взаимодействие: фокус, выделение текста, совпадение поиска.
    "search-mark": [mixSrgb(accent[0], 20, WHITE), mixSrgb(accent[1], 45, dark[7])],
    "focus-ring": [gray[7], dark[1]],
    selection: [mixSrgb(accent[0], 14, WHITE), accentSubtle[1]],

    // Данные: колонки задач, выполнение, блокировка, прогресс.
    "column-inbox": soft,
    "column-ready": [grape[8], grape[4]],
    "chart-track": [gray[2], dark[5]],
    "progress-track": progressTrack,
    "column-cancelled-fill": [mixSrgb(soft[0], 22, WHITE), mixSrgb(soft[1], 30, dark[6])],

    // Тени: подъём у меню, диалога и перетаскиваемой карточки.
    "card-shadow": [
      `0 1px 2px ${withAlpha(gray[9], 0.031)}`,
      `0 1px 2px ${withAlpha(BLACK, 0.16)}`,
    ],
    "card-hover": [
      `0 4px 14px ${withAlpha(gray[9], 0.059)}`,
      `0 4px 14px ${withAlpha(BLACK, 0.25)}`,
    ],
    "raised-shadow": [
      `0 1px 2px ${withAlpha(gray[9], 0.039)}, 0 12px 32px -18px ${withAlpha(gray[9], 0.2)}`,
      `0 1px 2px ${withAlpha(BLACK, 0.18)}, 0 12px 32px -18px ${withAlpha(BLACK, 0.5)}`,
    ],
  };
};

/**
 * Роли-ссылки: одинаковы в обеих схемах и следуют за базовой ролью.
 */
const ROLE_ALIASES: Record<string, string> = {
  highlight: "accent",
  "highlight-hover": "accent-hover",
  "highlight-ink": "accent-contrast",
  "nav-current-surface": "accent-subtle",
  "nav-current-ink": "accent-ink",
  "warning-ink": "warning",
  "column-in-progress": "accent",
  "column-review": "warning",
  "column-done": "success",
  "column-cancelled": "soft",
  completed: "success",
  blocked: "danger",
  progress: "accent",
};

/**
 * Виртуальные цвета Mantine для палитры состояния: варианты filled/light/outline/subtle
 * и цвет текста берут значения ролей, а не оттенков исходной палитры.
 */
const toneVariables = (palette: string, tone: Tone): Record<string, string> => {
  const role = `var(--tasks-${tone})`;
  const surface = tone === "accent" ? "var(--tasks-accent-subtle)" : `var(--tasks-${tone}-surface)`;
  const ink = tone === "accent" ? "var(--tasks-accent-ink)" : role;
  return {
    [`--mantine-color-${palette}-filled`]: role,
    [`--mantine-color-${palette}-filled-hover`]: `var(--tasks-tone-${tone}-filled-hover)`,
    [`--mantine-color-${palette}-light`]: surface,
    [`--mantine-color-${palette}-light-hover`]: `var(--tasks-tone-${tone}-light-hover)`,
    [`--mantine-color-${palette}-light-color`]: ink,
    [`--mantine-color-${palette}-outline`]: ink,
    [`--mantine-color-${palette}-outline-hover`]: surface,
    [`--mantine-color-${palette}-text`]: ink,
  };
};

/**
 * Связывает переменные Mantine с ролями Relay: поверхности, текст, нейтральное
 * главное действие, недоступное состояние и ошибки. Значения ставятся в блоки обеих
 * схем: так они заменяют схемные значения Mantine, а не уступают им по специфичности.
 */
const MANTINE_ROLE_VARIABLES: Record<string, string> = {
  "--mantine-color-dimmed": "var(--tasks-muted)",
  "--mantine-color-text": "var(--tasks-ink)",
  "--mantine-color-body": "var(--tasks-surface)",
  "--mantine-color-default": "var(--tasks-surface)",
  "--mantine-color-default-hover": "var(--tasks-subtle)",
  "--mantine-color-default-color": "var(--tasks-ink)",
  "--mantine-color-default-border": "var(--tasks-border)",
  "--mantine-color-anchor": "var(--tasks-accent-ink)",
  "--mantine-color-placeholder": "var(--tasks-soft)",
  "--mantine-color-error": "var(--tasks-danger)",
  "--mantine-color-success": "var(--tasks-success)",
  "--mantine-color-disabled": "var(--tasks-action-disabled)",
  "--mantine-color-disabled-color": "var(--tasks-action-disabled-text)",
  "--mantine-color-disabled-border": "var(--tasks-action-disabled-border)",
  "--mantine-primary-color-contrast": "var(--tasks-action-primary-text)",
  "--mantine-color-gray-filled": "var(--tasks-action-primary)",
  "--mantine-color-gray-filled-hover": "var(--tasks-action-primary-hover)",
  "--mantine-color-gray-text": "var(--tasks-neutral-text)",
  "--mantine-color-gray-light-color": "var(--tasks-neutral-text)",
};

/**
 * Формирует CSS-переменные темы для Mantine `cssVariablesResolver`.
 */
export const themeVariables: CSSVariablesResolver = (theme) => {
  const pairs = buildColorRoles(theme.colors);
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  for (const [name, [lightValue, darkValue]] of Object.entries(pairs)) {
    light[`--tasks-${name}`] = lightValue;
    dark[`--tasks-${name}`] = darkValue;
  }

  const mantine: Record<string, string> = { ...MANTINE_ROLE_VARIABLES };
  for (const [tone, palettes] of Object.entries(TONE_PALETTES) as [Tone, readonly string[]][]) {
    for (const palette of palettes) {
      Object.assign(mantine, toneVariables(palette, tone));
    }
  }
  Object.assign(light, mantine);
  Object.assign(dark, mantine);

  const variables: Record<string, string> = {};
  for (const [alias, role] of Object.entries(ROLE_ALIASES)) {
    variables[`--tasks-${alias}`] = `var(--tasks-${role})`;
  }

  return { variables, light, dark };
};
