/**
 * Соединяет подпись и число неразрывным пробелом, чтобы число не переносилось отдельно.
 */
export const countLabel = (label: string, count: number): string => `${label}\u00A0${count}`;
