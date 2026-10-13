// Удаление сущности тем же Core старой версии (CLI этой версии не имел команды удаления;
// Web/REST вызывали EntityDeletionService). Копируется в apps/cli временного worktree.
import { randomUUID } from "node:crypto";
import { openWorkspace } from "@relay/core/storage/workspace";
import { EntityDeletionService } from "@relay/core/application/entities/deletion";

const [cwd, kind, ref, actor] = process.argv.slice(2);
const workspace = await openWorkspace(cwd!);
const service = new EntityDeletionService(workspace);
const preview = await service.preview({ ref: ref!, kind: kind as never });
const result = await service.delete(
  { ref: ref!, kind: kind as never, ifVersion: preview.version, requestId: randomUUID(), actor },
  actor!,
);
process.stdout.write(JSON.stringify({ ok: true, data: { preview, result } }) + "\n");
