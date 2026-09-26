import type { ProductRecord } from "../../domain/product.js";
import type { Workspace } from "../../storage/workspace.js";
import { ProductRepository } from "../../storage/product.js";
import { DocumentLinksRepository } from "../../storage/document-links.js";
import { invariant } from "../../shared/errors.js";
import { GraphService } from "../graph/service.js";

/** Завершает уже начатую запись; вызывается до допуска внешних читателей под общей блокировкой. */
export async function recoverDocumentLinks(workspace: Workspace, owned: () => void): Promise<void> {
  const repository = new DocumentLinksRepository(workspace);
  const pending = await repository.readPending();
  if (!pending) return;
  await repository.publishProduct(pending, owned);
  const graph = new GraphService(workspace);
  while (pending.cursor < pending.steps.length) {
    const steps = pending.steps.slice(pending.cursor, pending.cursor + 100);
    if (pending.command === null) {
      const snapshot = await graph.read({
        root: `document:${pending.documentId}`,
        depth: 0,
        limit: 1,
      });
      pending.command = {
        operations: steps.map((step) => step.operation),
        ifVersion: snapshot.version,
        requestId: `document-${pending.requestKey}-${pending.cursor}`,
        actor: pending.actor,
      };
      await repository.writePending(pending, owned);
    }
    // Это явный вызов движка после продуктовой записи, а не вычисление рёбер при чтении.
    const result = await graph.mutate(pending.command, pending.actor);
    for (const [index, step] of steps.entries()) {
      if (step.operation.action === "remove") delete pending.bindings[step.key];
      if (step.operation.action === "add") {
        const { from, to, type } = step.operation;
        invariant(
          typeof from === "object" && typeof to === "object" && result.ids[index],
          "INVALID_DATA",
          "Не получен адрес сохранённого прикрепления",
          5,
        );
        pending.bindings[step.key] = { id: result.ids[index]!, from, to, type };
      }
    }
    pending.cursor += steps.length;
    pending.command = null;
    await repository.writePending(pending, owned);
  }
  await repository.finish(pending, owned);
}

/** Сохраняет документ и согласует только принадлежащие ему связи через API движка. */
export async function saveDocumentWithLinks(
  workspace: Workspace,
  record: ProductRecord,
  _actor: string,
  _requestKey: string,
  owned: () => void,
): Promise<void> {
  workspace.assertWritableStorage();
  await new ProductRepository(workspace).save(record, false, owned);
}
