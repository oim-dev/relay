import type { z } from "zod";
import type {
  PRODUCT_STATE_SCHEMA,
  PRODUCT_FIELDS_SCHEMA,
  PRODUCT_LINK_SCHEMA,
} from "../config/product.schema";

/** Согласованное состояние продукта. */
export type ProductState = z.infer<typeof PRODUCT_STATE_SCHEMA>;
/** Типизированная связь документа. */
export type ProductLink = z.infer<typeof PRODUCT_LINK_SCHEMA>;
/** Поля записи продукта. */
export type ProductFields = z.infer<typeof PRODUCT_FIELDS_SCHEMA>;
/** Поля операции; служебная идентичность контрактов назначается ядром. */
export type ProductInput =
  | Exclude<ProductFields, { kind: "scope" }>
  | {
      /** Вид агрегата. */
      kind: "scope";
      /** Владелец реализации. */
      applicationId: string;
      /** Активные обязательства. */
      contracts: Array<
        Omit<
          Extract<ProductFields, { kind: "scope" }>["contracts"][number],
          "id" | "active" | "basis"
        >
      >;
    };
/** Команда записи с защитой от потерянных обновлений. */
export type ProductCommand = {
  /** Создание или изменение. */
  action: "create" | "update";
  /** ID обновляемой записи. */
  id?: string;
  /** Полное содержание. */
  fields: ProductInput;
  /** Прочитанная ревизия. */
  ifRevision?: number;
  /** Отпечаток прочитанного графа. */
  ifVersion?: string;
  /** Корреляция HTTP-запроса, не ключ дедупликации. */
  requestId: string;
};
