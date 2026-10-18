import { z } from "zod";
import { readJson, atomicJson } from "@relay/core/storage/files";
import { AppError } from "@relay/core/shared/errors";
import {
  managedMarker,
  syncStatePath,
  hasManagedMetadata,
  readSyncStateFile,
  gitMetadataDirectory,
} from "@relay/core/storage/access";

export const DATA_BRANCH = "relay-data";
const oid = z.string().regex(/^[a-f0-9]{40,64}$/);
const legacyMarkerSchema = z.strictObject({
  version: z.literal(1),
  identity: z.string().min(1),
  origin: z.string().min(1),
  projectId: z.string().min(1),
  branch: z.literal(DATA_BRANCH),
});
export const worktreeMarkerSchema = z.strictObject({
  version: z.literal(2),
  identity: z.string().min(1),
  commonDir: z.string().min(1),
  sourceRoot: z.string().min(1),
  projectId: z.string().min(1),
  branch: z.literal(DATA_BRANCH),
});
export const markerSchema = z.union([legacyMarkerSchema, worktreeMarkerSchema]);
export type ManagedMarker = z.infer<typeof markerSchema>;
export const conflictSchema = z.strictObject({
  id: z.string(),
  base: oid,
  local: oid,
  remote: oid,
  paths: z.array(z.string()),
  reason: z.string(),
  fingerprint: z.string(),
});
export const stateSchema = z.strictObject({
  version: z.literal(1),
  firstDirty: z.number().nullable(),
  lastDirty: z.number().nullable(),
  requested: z.number().int().nonnegative(),
  checked: z.number().int().nonnegative(),
  attempted: z.number().int().nonnegative().default(0),
  generation: z.number().int().nonnegative(),
  committedGeneration: z.number().int().nonnegative().default(0),
  commitPendingSince: z.number().nullable().default(null),
  lastCommit: z.number().nullable().default(null),
  lastSuccess: z.number().nullable().default(null),
  lastAttempt: z.number().nullable().default(null),
  retryAt: z.number().nullable().default(null),
  failures: z.number().int().nonnegative().default(0),
  observedOrigin: z.string().nullable().default(null),
  sendingGeneration: z.number().int().nonnegative().nullable(),
  lastFetch: z.number().nullable(),
  remote: oid.nullable(),
  origin: z.string().nullable().default(null),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  conflict: conflictSchema.nullable(),
  resolution: oid.nullable(),
});
export type SyncState = z.infer<typeof stateSchema>;
export const initialState = (): SyncState => ({
  version: 1,
  firstDirty: null,
  lastDirty: null,
  requested: 0,
  checked: 0,
  attempted: 0,
  generation: 0,
  committedGeneration: 0,
  commitPendingSince: null,
  lastCommit: null,
  lastSuccess: null,
  lastAttempt: null,
  retryAt: null,
  failures: 0,
  observedOrigin: null,
  sendingGeneration: null,
  lastFetch: null,
  remote: null,
  origin: null,
  error: null,
  conflict: null,
  resolution: null,
});
export const publicationSchema = z.strictObject({
  oldHead: oid,
  newHead: oid,
  source: z.string(),
  target: z.string(),
  resolution: z.boolean(),
});

export async function marker(root: string): Promise<ManagedMarker | undefined> {
  if (!(await hasManagedMetadata(root))) return undefined;
  const parsed = markerSchema.safeParse(await readJson(await managedMarker(root)));
  if (!parsed.success)
    throw new AppError("SYNC_STATE_INVALID", "Метаданные Git-базы повреждены", 4);
  return parsed.data;
}
export async function readState(root: string): Promise<SyncState> {
  const parsed = stateSchema.safeParse(await readSyncStateFile(root));
  if (!parsed.success)
    throw new AppError("SYNC_STATE_INVALID", "Состояние синхронизации повреждено", 4);
  return parsed.data;
}
export async function saveState(root: string, state: SyncState): Promise<void> {
  await atomicJson(
    await syncStatePath(root),
    stateSchema.parse(state),
    await gitMetadataDirectory(root),
  );
}
export function pushDeadline(
  state: Pick<SyncState, "firstDirty" | "lastDirty">,
  debounce = 2000,
  maxWait = 15000,
) {
  return state.firstDirty === null || state.lastDirty === null
    ? null
    : Math.min(state.lastDirty + debounce, state.firstDirty + maxWait);
}

/** Частота локальных коммитов не зависит от доступности origin и сетевого backoff. */
export function commitDeadline(state: SyncState): number | null {
  if (state.generation <= state.committedGeneration) return null;
  const first = state.commitPendingSince ?? state.firstDirty ?? 0;
  return Math.min((state.lastDirty ?? first) + 2000, first + 15000);
}
