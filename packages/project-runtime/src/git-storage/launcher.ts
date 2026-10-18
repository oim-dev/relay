import { spawn } from "node:child_process";
import { mkdir, stat, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { exists, atomicJson, readJson } from "@relay/core/storage/files";
import { withStorageLock } from "@relay/core/storage/lock";
import { AppError, isErrno } from "@relay/core/shared/errors";
import { readState, saveState, pushDeadline, marker } from "./state.js";
import { synchronize, withDataLock } from "./service.js";

const reservation = (root: string) => join(root, ".git/relay-worker-start.json");
const control = (root: string) => join(root, ".git/relay-control");
const lease = (root: string) => join(root, ".git/relay-worker");

async function workerFile() {
  const source = import.meta.url.endsWith(".ts");
  for (const relative of [
    source ? "./worker.ts" : "./worker.js",
    "./relay-sync-worker.js",
    "../relay-sync-worker.js",
  ])
    if (await exists(fileURLToPath(new URL(relative, import.meta.url))))
      return { source, path: fileURLToPath(new URL(relative, import.meta.url)) };
  throw new AppError(
    "SYNC_WORKER_MISSING",
    "В поставке отсутствует процесс синхронизации Relay",
    4,
  );
}

export async function ensureWorker(root: string): Promise<void> {
  if (!(await marker(root))) return;
  await mkdir(control(root), { recursive: true });
  await withStorageLock(
    control(root),
    async () => {
      const state = await readState(root);
      if (state.conflict && !state.resolution) return;
      const lock = await stat(join(lease(root), "write.lock")).catch((error: unknown) => {
        if (isErrno(error, "ENOENT")) return undefined;
        throw error;
      });
      if (lock && Date.now() - lock.mtimeMs < 10_000) return;
      if (await exists(reservation(root))) {
        const start = (await readJson(reservation(root))) as { at?: number };
        if (typeof start.at === "number" && Date.now() - start.at < 5000) return;
      }
      const worker = await workerFile();
      const args = worker.source
        ? ["--conditions=tasks-source", "--import", import.meta.resolve("tsx")]
        : [];
      await atomicJson(reservation(root), { at: Date.now() }, join(root, ".git"));
      await new Promise<void>((accept, reject) => {
        const child = spawn(process.execPath, [...args, worker.path, root], {
          cwd: root,
          env: process.env,
          stdio: "ignore",
          detached: true,
          windowsHide: true,
        });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          accept();
        });
      });
    },
    control(root),
  );
}

/** Сеть и ожидание debounce принадлежат короткоживущему процессу, а не вызову CLI. */
export async function runWorker(root: string): Promise<void> {
  if (!(await marker(root))) return;
  await mkdir(lease(root), { recursive: true });
  let failed = false;
  try {
    await withStorageLock(
      lease(root),
      async () => {
        await atomicJson(
          join(root, ".git/relay-worker-pid.json"),
          { pid: process.pid },
          join(root, ".git"),
        );
        const started = Date.now();
        while (Date.now() - started < 60_000) {
          const state = await readState(root);
          if (state.conflict && !state.resolution) return;
          const deadline = pushDeadline(state);
          if (
            state.requested > state.checked ||
            state.resolution ||
            (deadline !== null && deadline <= Date.now())
          ) {
            await synchronize(root, {
              publish: !!state.resolution || (deadline !== null && deadline <= Date.now()),
            });
            continue;
          }
          if (deadline === null) return;
          await delay(Math.max(1, Math.min(500, deadline - Date.now())));
        }
      },
      lease(root),
      { wait: false },
    );
  } catch (error) {
    if (isErrno(error, "ELOCKED")) return;
    if (!(await marker(root))) return;
    failed = true;
    await withDataLock(root, async () => {
      const state = await readState(root);
      state.error = {
        code: error instanceof AppError ? error.code : "SYNC_WORKER_FAILED",
        message: error instanceof Error ? error.message : "Ошибка процесса синхронизации",
      };
      await saveState(root, state);
    });
  } finally {
    // Lease уже освобождён. Запрос, пришедший на границе выхода, будет замечен здесь
    // либо запустит преемника сам; ожидающая запись не исчезает вместе с процессом.
    if (await marker(root)) {
      await mkdir(control(root), { recursive: true });
      await withStorageLock(
        control(root),
        () => rm(reservation(root), { force: true }),
        control(root),
      );
    }
  }
  if (!failed) {
    const state = await readState(root);
    if (!state.conflict && (state.requested > state.checked || state.firstDirty !== null))
      await ensureWorker(root);
  }
}
