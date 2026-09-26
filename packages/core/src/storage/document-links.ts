import { dirname, join } from "node:path";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import { graphMutationSchema, entityRefSchema } from "../domain/entity-graph.js";
import { productIdSchema } from "../domain/product.js";
import { graphDigest } from "./graph-format.js";
import { atomicJson, exists, readJson, syncDirectory } from "./files.js";
import { ProductTransaction } from "./product-transaction.js";
import { invariant } from "../shared/errors.js";
import type { Workspace } from "./workspace.js";

const bindingSchema = z.strictObject({
  id: z.string(),
  from: entityRefSchema,
  to: entityRefSchema,
  type: z.string(),
});
const bindingsSchema = z.record(z.string(), bindingSchema);
const fileSchema = z.strictObject({
  path: z
    .string()
    .regex(/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.json$/)
    .refine((path) => !path.includes("..")),
  before: z.string().nullable(),
  after: z.unknown(),
});
const stepSchema = z.strictObject({
  key: z.string(),
  operation: graphMutationSchema.shape.operations.element,
});
export const documentLinksPendingSchema = z.strictObject({
  version: z.literal(1),
  documentId: productIdSchema,
  actor: z.string(),
  requestKey: z.string(),
  files: z.array(fileSchema),
  bindingHash: z.string().nullable(),
  bindings: bindingsSchema,
  steps: z.array(stepSchema).max(2200),
  cursor: z.number().int().nonnegative(),
  command: graphMutationSchema.nullable(),
});
/** Принадлежность связи конкретному продуктовому линку. */
export type DocumentLinkBindings = z.infer<typeof bindingsSchema>;
/** Долговечное состояние составной предметной операции. */
export type DocumentLinksPending = z.infer<typeof documentLinksPendingSchema>;
/** Один элемент разницы продуктовых прикреплений. */
export type DocumentLinkStep = z.infer<typeof stepSchema>;

/** Контрольная точка только незавершённого прежнего workflow, не квитанция команды. */
export function advanceDocumentLinks(pending: DocumentLinksPending, ids: readonly string[]) {
  const steps = pending.steps.slice(pending.cursor, pending.cursor + 100);
  for (const [index, step] of steps.entries()) {
    if (step.operation.action === "remove") delete pending.bindings[step.key];
    if (step.operation.action === "add") {
      const { from, to, type } = step.operation;
      invariant(
        typeof from === "object" && typeof to === "object" && ids[index],
        "INVALID_DATA",
        "Не получен адрес сохранённого прикрепления",
        5,
      );
      pending.bindings[step.key] = { id: ids[index]!, from, to, type };
    }
  }
  pending.cursor += steps.length;
  pending.command = null;
}

/** Хранит только журнал координации и соответствие линков рёбрам, не копию графа. */
export class DocumentLinksRepository {
  readonly root: string;
  readonly pending: string;
  constructor(readonly workspace: Workspace) {
    this.root = join(dirname(workspace.configPath), "product");
    this.pending = join(this.root, ".transactions", "document-links.json");
  }
  bindingPath(id: string): string {
    return join(this.root, ".document-links", `${productIdSchema.parse(id)}.json`);
  }
  async bindings(id: string): Promise<DocumentLinkBindings> {
    const path = this.bindingPath(id);
    if (!(await exists(path))) return {};
    return z
      .strictObject({ version: z.literal(1), bindings: bindingsSchema })
      .parse(await readJson(path)).bindings;
  }
  async hash(path: string): Promise<string | null> {
    return (await exists(path)) ? graphDigest(await readJson(path, 128 * 1024 * 1024)) : null;
  }
  async readPending(): Promise<DocumentLinksPending | undefined> {
    if (!(await exists(this.pending))) return undefined;
    return documentLinksPendingSchema.parse(await readJson(this.pending, 128 * 1024 * 1024));
  }
  async writePending(pending: DocumentLinksPending, owned: () => void): Promise<void> {
    const value = documentLinksPendingSchema.parse(pending);
    invariant(
      Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024 * 1024,
      "RESPONSE_TOO_LARGE",
      "Операция документа превышает 128 МиБ",
    );
    await atomicJson(this.pending, value, this.workspace.runtime, false, owned);
  }
  async prepareFiles(files: { path: string; after: unknown }[]) {
    return Promise.all(
      files.map(async (file) => ({ ...file, before: await this.hash(join(this.root, file.path)) })),
    );
  }
  async publishProduct(pending: DocumentLinksPending, owned: () => void): Promise<void> {
    for (const file of pending.files) {
      const actual = await this.hash(join(this.root, file.path));
      const after = file.after === null ? null : graphDigest(file.after);
      invariant(
        actual === file.before || actual === after,
        "DOCUMENT_LINK_RECOVERY_CONFLICT",
        "Документ изменён вне незавершённой операции. Автоматическое восстановление остановлено.",
        5,
      );
    }
    await new ProductTransaction(this.workspace).publish(
      pending.files.map(({ path, after }) => ({ path, after })),
      owned,
    );
  }
  async finish(pending: DocumentLinksPending, owned: () => void): Promise<void> {
    const path = this.bindingPath(pending.documentId);
    const value = { version: 1, bindings: pending.bindings };
    const actual = await this.hash(path);
    invariant(
      actual === pending.bindingHash || actual === graphDigest(value),
      "DOCUMENT_LINK_RECOVERY_CONFLICT",
      "Сопоставление прикреплений изменено вне незавершённой операции",
      5,
    );
    await atomicJson(path, value, this.workspace.runtime, false, owned);
    owned();
    await unlink(this.pending);
    await syncDirectory(dirname(this.pending));
  }
}
