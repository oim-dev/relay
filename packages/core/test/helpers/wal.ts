import type { TestContext } from "node:test";
import { StorageTransaction } from "../../src/storage/entity-store/transaction.js";
import type { TransactionProbe } from "../../src/storage/entity-store/transaction.js";

/** Инъекция в настоящий WAL, а не в отключённый legacy writer. */
export function failWal(t: TestContext, probe: TransactionProbe) {
  const publish = StorageTransaction.prototype.publish;
  t.mock.method(
    StorageTransaction.prototype,
    "publish",
    async function (this: StorageTransaction, ...args: Parameters<typeof publish>) {
      return publish.apply(new StorageTransaction(this.root, probe), args);
    },
  );
}
