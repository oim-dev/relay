import type { z } from "zod";
import type { EntityRef } from "@relay/contracts/entities/graph";
import type { JsonValue, StoredKeySpace, StoredRecord } from "@relay/contracts/storage";
import type { StorageLayout } from "@relay/contracts/storage-maintenance";

export type { StorageLayout };
/** Дисковые данные записи: Markdown закодирован массивами строк. */
export type DiskData = Record<string, JsonValue>;
/** Оболочка записи без data; переход читает её, но не меняет. */
export type EnvelopeView = Readonly<Omit<StoredRecord, "data">>;

type TransitionBase = {
  /** Стабильный ID: строчные латинские буквы, цифры, точка и дефис. */
  readonly id: string;
  /** Версия определения; изменение кода без изменения схем требует её повышения. */
  readonly version: number;
  readonly description: string;
  /** ID переходов, которые должны выполниться раньше, если они применимы. */
  readonly dependsOn?: readonly string[];
};

/** Локальный N→N+1 одной записи владельца; чистая функция над дисковыми данными. */
export type RecordTransition = TransitionBase & {
  readonly type: "record";
  readonly owner: string;
  readonly from: number;
  readonly to: number;
  /** Замороженная дисковая схема версии from (без defaults/transform/strip). */
  readonly input: z.ZodType;
  /** Замороженная дисковая схема версии to. */
  readonly output: z.ZodType;
  apply(data: DiskData, context: { ref: EntityRef; envelope: EnvelopeView }): DiskData;
};

/** Контролируемое чтение согласованного снимка; публикации и доступа к ФС нет. */
export interface SnapshotView {
  /** Все записи вида (действующие и надгробия) в текущем состоянии подготовки, по ID. */
  records(kind: string): readonly Readonly<StoredRecord>[];
  /** Набор отношений владельца в дисковой форме; null — набора нет. */
  relations(owner: EntityRef): Readonly<JsonValue> | null;
  keyspaces(): readonly Readonly<StoredKeySpace>[];
  project(): { readonly id: string | null };
}

/** Подготовленные изменения snapshot-перехода; исполнитель проверяет и публикует их сам. */
export interface ChangeSet {
  put(record: StoredRecord): void;
  remove(ref: EntityRef, category: string): void;
  relations(owner: EntityRef, value: JsonValue | null): void;
  removeSource(path: string, category: string): void;
  /** Детерминированный технический ID: uuid v8 от ID перехода и стабильного seed. */
  newId(seed: string): string;
}

/** Переход над согласованным снимком: объединение, разделение, перенос отношений. */
export type SnapshotTransition = TransitionBase & {
  readonly type: "snapshot";
  /** Вид → версия, к которой должны прийти все записи вида до шага. */
  readonly requires: Readonly<Record<string, number>>;
  /** Вид → версия после шага; removed — вид перестаёт существовать. */
  readonly produces: Readonly<Record<string, number | "removed">>;
  readonly inputs: Readonly<Record<string, z.ZodType>>;
  readonly outputs: Readonly<Record<string, z.ZodType>>;
  apply(view: SnapshotView, changes: ChangeSet): void;
};

export type DataTransition = RecordTransition | SnapshotTransition;

export type PhysicalArea = "config-root" | "storage-root";

/** Непосредственный потомок каталога исходной раскладки; symlink и прочее — other. */
export type PhysicalDirEntry = {
  readonly name: string;
  readonly type: "file" | "dir" | "other";
};

/**
 * Каталог видов для физического шага: коллекции текущего реестра и исторических видов,
 * полная проверка записи её версии (оболочка 3 и данные своей dataVersion).
 */
export interface PhysicalRecordCatalog {
  /** Вид по каталогу entities/<collection> или relations/<collection>; undefined — неизвестен. */
  kindOfCollection(collection: string): string | undefined;
  /** Коллекция вида; undefined — вид неизвестен. */
  collectionOf(kind: string): string | undefined;
  /** Проверка записи в оболочке 3 схемой её версии данных; ошибка — AppError хранилища. */
  validateRecord(value: unknown): StoredRecord;
}

/** Ввод-вывод исходной раскладки только для чтения; определяет исполнитель физического шага. */
export interface PhysicalSourceIo {
  readonly layout: StorageLayout;
  /** POSIX-путь файла конфигурации относительно корня базы (область config-root). */
  readonly configName: string;
  /**
   * Абсолютный путь конфигурации. Только для производных значений прежнего формата,
   * которые старый reader вычислял из расположения (имя проекта и ID продукта по умолчанию).
   */
  readonly configPath: string;
  /** Байты файла в управляемой области; null — файла нет. Symlink — ошибка, а не переход. */
  read(path: string, area: PhysicalArea): Promise<Uint8Array | null>;
  /** Потомки каталога по возрастанию имени; [] — каталога нет. */
  list(path: string, area: PhysicalArea): Promise<readonly PhysicalDirEntry[]>;
  readonly catalog: PhysicalRecordCatalog;
}

/** Удаляемый по правилу исходный файл с категорией контракта хранения. */
export type PhysicalRemovedSource = {
  readonly path: string;
  readonly area: PhysicalArea;
  /**
   * converted-source — содержание перенесено в записи/отношения; derived-index — производный
   * индекс; прочие категории — распознанные исторические журналы, квитанции и события.
   */
  readonly category: string;
};

/** Результат физического шага: записи в формате 4 (оболочка 3) с исходными dataVersion. */
export type PhysicalSnapshot = {
  /** Все записи, включая надгробия, по адресу kind:id. Данные — в исходной dataVersion. */
  readonly records: readonly StoredRecord[];
  /**
   * Наборы отношений владельцев в собранной встроенной форме
   * `{schemaVersion: 1, owner, storage: "inline", entries}`; inline/сегменты выбирает исполнитель.
   */
  readonly relations: readonly { owner: EntityRef; value: JsonValue }[];
  readonly keyspaces: readonly StoredKeySpace[];
  /** Новое содержимое файла конфигурации; null — файл не меняется. */
  readonly config: JsonValue | null;
  /** productId для manifest формата 4; null — поля нет. */
  readonly productId: string | null;
  /** Исходные файлы, которые исполнитель удаляет в той же публикации. */
  readonly removeSources: readonly PhysicalRemovedSource[];
  /** Удалённые по правилу вложенные исторические структуры: категория → количество. */
  readonly removed: Readonly<Record<string, number>>;
};

/** Составной перенос раскладки в формат 4; записи сохраняют исходные dataVersion. */
export type PhysicalTransition = TransitionBase & {
  readonly type: "physical";
  readonly from: Exclude<StorageLayout, "unified-4">;
  readonly to: "unified-4";
  /**
   * Чистое чтение: без записи, часов и случайных ID. Блокеры — AppError хранилища;
   * при нескольких причинах у ошибки есть поле `blockers` со всеми (см. physicalBlockers).
   */
  read(io: PhysicalSourceIo, owned: () => void): Promise<PhysicalSnapshot>;
};

export type TransitionDefinition = DataTransition | PhysicalTransition;

/** Проверка дисковых данных конкретной версии вида. */
export type VersionValidator = {
  readonly kind: string;
  readonly version: number;
  /** current — текущий кодек; transition — входная схема перехода из этой версии. */
  readonly source: "current" | "transition";
  parse(data: DiskData): DiskData;
};
