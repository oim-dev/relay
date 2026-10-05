import { readSessionStored, writeSessionStored } from "infra/browser-storage";

/** Сохранённое положение каталога при уходе с экрана. */
export type ReturnPoint = {
  /** Адрес каталога с условиями и объёмом. */
  location: string;
  /** Вертикальная прокрутка окна. */
  scrollY: number;
  /** Материал, который открыли последним. */
  materialId: string | null;
};

/** Ключ точки возврата проекта в хранилище вкладки. */
const getStorageKey = (projectId: string): string => `relay:library-return:${projectId}`;

/** Проверяет запись из хранилища вкладки. */
const isReturnPoint = (value: unknown): value is ReturnPoint =>
  typeof value === "object" &&
  value !== null &&
  "location" in value &&
  typeof value.location === "string" &&
  "scrollY" in value &&
  typeof value.scrollY === "number" &&
  "materialId" in value &&
  (value.materialId === null || typeof value.materialId === "string");

/** Читает точку возврата каталога проекта, сохранённую в этой вкладке. */
export const readReturnPoint = (projectId: string): ReturnPoint | null => {
  const stored = readSessionStored(getStorageKey(projectId));
  return isReturnPoint(stored) ? stored : null;
};

/** Запоминает точку возврата каталога проекта в этой вкладке. */
export const writeReturnPoint = (projectId: string, point: ReturnPoint): void => {
  writeSessionStored(getStorageKey(projectId), point);
};
