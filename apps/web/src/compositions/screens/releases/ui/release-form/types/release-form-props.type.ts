import type { Release, ReleaseStatus } from "domains/releases";

/** Параметры визуальной области. */
export type ReleaseFormProps = {
  /** Исходная запись либо новый релиз. */
  release: Release;
  /** Изоляция черновика. */
  projectId: string;
  /** Создаётся новый релиз. */
  isNew: boolean;
  /** Сохранить одним действием запись, статус и состав. */
  onSave: (release: Release) => Promise<string | null>;
  /** Свернуть с сохранением черновика. */
  onClose: () => void;
};

/** Реквизиты, статус и выбор планов в форме релиза. */
export type ReleaseFormValues = {
  /** Ревизия исходной записи; фоновые ответы не заменяют её. */
  revision: number;
  /** Название выпуска. */
  title: string;
  /** Версия или обозначение. */
  version: string;
  /** Краткий обычный текст. */
  summary: string;
  /** Полное описание Markdown. */
  description: string;
  /** Плановая дата либо пустая строка. */
  plannedFor: string;
  /** Собственный статус релиза. */
  status: ReleaseStatus;
  /** Полный выбор, включая скрытые поиском строки. */
  planIds: string[];
};
