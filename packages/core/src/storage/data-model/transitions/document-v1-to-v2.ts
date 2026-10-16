import { documentDataV1Input, documentDataV2 } from "../history/document-v1-v2.js";
import type { RecordTransition } from "../types.js";

/**
 * Документ v1 → v2. Выпущенные материалы v1 были Markdown-документами без тегов: переход
 * явно записывает `documentFormat: "markdown"` и `tags: []`. Документ промежуточной сборки
 * библиотеки (`documentDataV1Library`) уже содержит формат, теги и адрес ссылки — они
 * сохраняются без изменений. Текст, связи, раздел, состояние и закрепление не меняются.
 */
export const documentV1ToV2: RecordTransition = {
  id: "document-v1-to-v2",
  version: 1,
  type: "record",
  description: "Формат материала и теги документа: markdown и пустой список для прежних записей",
  owner: "document",
  from: 1,
  to: 2,
  input: documentDataV1Input,
  output: documentDataV2,
  apply: (data) =>
    data.documentFormat === undefined ? { ...data, documentFormat: "markdown", tags: [] } : data,
};
