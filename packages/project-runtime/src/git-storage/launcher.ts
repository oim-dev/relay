import { spawn } from "node:child_process";
import { mkdir, stat, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { exists, atomicJson, readJson } from "@relay/core/storage/files";
import { withStorageLock } from "@relay/core/storage/lock";
import { AppError, isErrno } from "@relay/core/shared/errors";
import { readState, saveState, commitDeadline, marker } from "./state.js";
import { checkpointLocal, synchronize, withDataLock } from "./service.js";
import { gitMetadataDirectory } from "@relay/core/storage/access";
import { currentOrigin } from "./remote.js";

export async function workerPaths(root: string) {
  const directory = await gitMetadataDirectory(root);
  return {
    directory,
    reservation: join(directory, "relay-worker-start.json"),
    control: join(directory, "relay-control"),
    lease: join(directory, "relay-worker"),
  };
}

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
  const paths = await workerPaths(root);
  await mkdir(paths.control, { recursive: true });
  await withStorageLock(
    paths.control,
    async () => {
      let state = await readState(root);
      const origin = (await currentOrigin(root))?.identity ?? null;
      if (state.observedOrigin !== origin) {
        await withDataLock(root, async () => {
          state = await readState(root);
          if (state.observedOrigin === origin) return;
          state.observedOrigin = origin;
          state.retryAt = null;
          state.requested++;
          await saveState(root, state);
        });
      }
      const pending = state.generation > state.committedGeneration;
      if (!pending && state.conflict && !state.resolution) return;
      if (
        !pending &&
        state.requested <= Math.max(state.checked, state.attempted) &&
        (state.retryAt ?? 0) > Date.now()
      )
        return;
      const lock = await stat(join(paths.lease, "write.lock")).catch((error: unknown) => {
        if (isErrno(error, "ENOENT")) return undefined;
        throw error;
      });
      if (lock && Date.now() - lock.mtimeMs < 10_000) return;
      if (await exists(paths.reservation)) {
        const start = (await readJson(paths.reservation)) as { at?: number };
        if (typeof start.at === "number" && Date.now() - start.at < 5000) return;
      }
      const worker = await workerFile();
      const args = worker.source
        ? ["--conditions=tasks-source", "--import", import.meta.resolve("tsx")]
        : [];
      await atomicJson(paths.reservation, { at: Date.now() }, paths.directory);
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
    paths.control,
  );
}

/** Локальные коммиты продолжаются параллельно сетевому ожиданию. При очереди worker переживает CLI. */
export async function runWorker(root: string): Promise<void> {
  if (!(await marker(root))) return;
  const paths = await workerPaths(root);
  await mkdir(paths.lease, { recursive: true });
  let failed = false;
  try {
    await withStorageLock(
      paths.lease,
      async () => {
        await atomicJson(
          join(paths.directory, "relay-worker-pid.json"),
          { pid: process.pid },
          paths.directory,
        );
        let network: Promise<void> | undefined;
        let reconciled = false;
        try {
          while (await marker(root)) {
            let state = await readState(root);
            const deadline = commitDeadline(state);
            if (
              (!reconciled && deadline === null) ||
              (deadline !== null && deadline <= Date.now())
            ) {
              await checkpointLocal(root);
              reconciled = true;
              state = await readState(root);
            }
            const localPending = state.generation > state.committedGeneration;
            const conflict = state.conflict && !state.resolution;
            if (
              !network &&
              !localPending &&
              !conflict &&
              ((state.retryAt ?? 0) <= Date.now() ||
                state.requested > Math.max(state.checked, state.attempted))
            ) {
              network = synchronize(root)
                .then(
                  () => {},
                  () => {},
                )
                .finally(() => {
                  network = undefined;
                });
            }
            if (!network && !localPending && (conflict || state.firstDirty === null)) return;
            await delay(250);
          }
        } finally {
          await network;
        }
      },
      paths.lease,
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
      await mkdir(paths.control, { recursive: true });
      await withStorageLock(
        paths.control,
        () => rm(paths.reservation, { force: true }),
        paths.control,
      );
    }
  }
  if (!failed) {
    const state = await readState(root);
    if (
      state.generation > state.committedGeneration ||
      (!state.conflict && state.requested > Math.max(state.checked, state.attempted))
    )
      await ensureWorker(root);
  }
}

/** Явный запрос ускоряет фоновую попытку; HTTP-ответ не ждёт Git и не повторяет мутации. */
export async function requestSynchronization(root: string): Promise<void> {
  await withDataLock(root, async () => {
    const state = await readState(root);
    state.requested++;
    state.retryAt = null;
    await saveState(root, state);
  });
  await ensureWorker(root);
}
