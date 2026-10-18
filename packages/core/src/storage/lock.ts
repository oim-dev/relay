import lockfile from "proper-lockfile";
import { basename, dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { AppError } from "../shared/errors.js";

/** Служебные файлы находятся рядом с хранилищем, на той же файловой системе. */
export function runtimeDirectory(root: string): string {
  if (basename(root) === "relay.workspace.json")
    return join(dirname(root), ".relay/runtime/workspace");
  if (basename(dirname(root)) === ".relay") return join(dirname(root), "runtime");
  return join(dirname(root), `.${basename(root).replace(/^\.+/, "") || "tasks"}-runtime`);
}

export async function prepareRuntime(root: string): Promise<string> {
  const runtime = runtimeDirectory(root);
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, ".gitignore"), "*\n", { flag: "wx" }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  return runtime;
}

/** Общая короткая блокировка защищает также инварианты между разными карточками. */
export async function withStorageLock<T>(
  root: string,
  operation: (assertOwned: () => void) => Promise<T>,
  runtime?: string,
  options: { wait?: boolean } = {},
): Promise<T> {
  const directory = runtime ?? (await prepareRuntime(root));
  let compromised: Error | undefined;
  const release = await lockfile.lock(root, {
    lockfilePath: join(directory, "write.lock"),
    realpath: false,
    stale: 10000,
    update: 2000,
    retries:
      options.wait === false
        ? 0
        : { retries: 60, factor: 1.2, minTimeout: 25, maxTimeout: 250, randomize: true },
    onCompromised(error) {
      compromised = error;
    },
  });
  const assertOwned = () => {
    if (compromised)
      throw new AppError("LOCK_LOST", "Потеряна блокировка хранилища; запись отменена", 4);
  };
  try {
    assertOwned();
    return await operation(assertOwned);
  } finally {
    if (!compromised) await release();
  }
}
