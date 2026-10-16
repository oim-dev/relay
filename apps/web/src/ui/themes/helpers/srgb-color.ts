/**
 * Цвет в sRGB: каналы 0–255 и непрозрачность 0–1.
 */
type SrgbColor = {
  red: number;
  green: number;
  blue: number;
  alpha: number;
};

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

const parseHex = (color: string): SrgbColor => {
  const digits = HEX_COLOR.exec(color)?.[1];
  if (digits === undefined) {
    throw new Error(`Цвет темы должен быть hex-значением sRGB, получено: ${color}`);
  }
  const full =
    digits.length === 3
      ? digits
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : digits;
  return {
    red: Number.parseInt(full.slice(0, 2), 16),
    green: Number.parseInt(full.slice(2, 4), 16),
    blue: Number.parseInt(full.slice(4, 6), 16),
    alpha: 1,
  };
};

const toChannelHex = (channel: number): string => Math.round(channel).toString(16).padStart(2, "0");

const format = (color: SrgbColor): string => {
  if (color.alpha >= 1) {
    return `#${toChannelHex(color.red)}${toChannelHex(color.green)}${toChannelHex(color.blue)}`;
  }
  const alpha = Math.round(color.alpha * 1000) / 1000;
  return `rgba(${Math.round(color.red)}, ${Math.round(color.green)}, ${Math.round(color.blue)}, ${alpha})`;
};

/**
 * Смешивает два непрозрачных hex-цвета в sRGB, как `color-mix(in srgb, first weight%, second)`.
 * Результат — обычный hex, который не зависит от поддержки `color-mix()` браузером.
 */
export const mixSrgb = (first: string, weight: number, second: string): string => {
  const from = parseHex(first);
  const to = parseHex(second);
  const share = weight / 100;
  return format({
    red: from.red * share + to.red * (1 - share),
    green: from.green * share + to.green * (1 - share),
    blue: from.blue * share + to.blue * (1 - share),
    alpha: 1,
  });
};

/**
 * Возвращает тот же sRGB-цвет с заданной непрозрачностью в виде `rgba()`.
 */
export const withAlpha = (color: string, alpha: number): string =>
  format({ ...parseHex(color), alpha });
