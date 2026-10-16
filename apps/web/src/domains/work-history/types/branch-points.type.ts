/** Краткая точка той же проекции, которая рисуется на линии ветки. */
export type BranchPoint = {
  /** Производный адрес для point API, включая lifecycle-точки. */
  id: string;
  title: string;
  summary: string;
  at: string;
  /** Подпись события с учётом сохранённого авторского участия. */
  label: string;
};

/** Страница одного серверного состава с исходным смещением. */
export type BranchPointPage = {
  items: BranchPoint[];
  total: number;
  offset: number;
  nextOffset: number | null;
  version: string;
};

/** Список всех графовых точек одной ветки с явным продолжением. */
export type BranchPointsState = {
  items: BranchPoint[];
  /** Полное число точек ветки; null до первого успешного чтения. */
  total: number | null;
  hasMore: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  error: Error | undefined;
  refresh: () => void;
  loadMore: () => void;
};
