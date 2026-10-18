import { z } from "zod";
import { join } from "node:path";
import { readJson, atomicJson } from "@relay/core/storage/files";
import { AppError } from "@relay/core/shared/errors";
import {
  managedMarker,
  syncStatePath,
  hasManagedMetadata,
  readSyncStateFile,
} from "@relay/core/storage/access";

export const DATA_BRANCH = "relay-data";
const oid = z.string().regex(/^[a-f0-9]{40,64}$/);
export const markerSchema = z.strictObject({
  version: z.literal(1),
  identity: z.string().min(1),
  origin: z.string().min(1),
  projectId: z.string().min(1),
  branch: z.literal(DATA_BRANCH),
});
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
  generation: z.number().int().nonnegative(),
  sendingGeneration: z.number().int().nonnegative().nullable(),
  lastFetch: z.number().nullable(),
  remote: oid.nullable(),
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
  generation: 0,
  sendingGeneration: null,
  lastFetch: null,
  remote: null,
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
  const parsed = markerSchema.safeParse(await readJson(managedMarker(root)));
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
  await atomicJson(syncStatePath(root), stateSchema.parse(state), join(root, ".git"));
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
