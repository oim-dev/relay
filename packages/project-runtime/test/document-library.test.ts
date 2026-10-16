import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initialize } from "@relay/core/storage/workspace";
import { createLocalBackend } from "../src/backend/local.js";

test("Библиотека local Backend: адресные записи, исходный CAS и общая ревизия метаданных", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-document-backend-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initialize(root, "tasks");
  const backend = await createLocalBackend(root);
  const document = await backend.entities.create(
    {
      data: {
        kind: "document",
        name: "Документ",
        summary: "",
        body: "## Markdown  \n",
        documentKind: "rules",
      },
      requestId: "document",
    },
    "creator",
  );
  const before = await backend.entities.get({ ref: document.key });
  const command = {
    ref: document.key,
    source: "relations" as const,
    action: "link" as const,
    target: "PROJECT",
    ifRevision: document.revision,
    requestId: "link",
  };
  const saved = await backend.documents.changeRelation(command, "writer");
  const page = await backend.documents.links({ ref: document.key, limit: 1 });
  assert.equal(page.total, 1);
  assert.equal(page.revision, saved.revision);
  const detail = await backend.entities.get({ ref: document.key });
  assert.equal(detail.revision, saved.revision);
  assert.equal(detail.metadata?.createdBy, before.metadata?.createdBy);
  assert.equal(detail.metadata?.createdAt, before.metadata?.createdAt);
  assert.equal(detail.metadata?.updatedBy, "writer");
  await assert.rejects(backend.documents.changeRelation(command, "stale"), {
    code: "REVISION_CONFLICT",
  });
  const unlinked = await backend.documents.changeRelation(
    { ...command, action: "unlink", ifRevision: saved.revision, actor: "explicit" },
    "ignored",
  );
  assert.equal((await backend.documents.links({ ref: document.key })).total, 0);
  assert.equal((await backend.entities.get({ ref: document.key })).revision, unlinked.revision);
  const sections = await backend.documents.sections();
  const created = await backend.documents.changeSection(
    {
      action: "create",
      id: "one",
      name: "Один",
      ifRevision: sections.revision,
      requestId: "create",
    },
    "writer",
  );
  const updated = await backend.documents.changeSection(
    {
      action: "update",
      id: "one",
      name: "Новое имя",
      ifRevision: created.revision,
      requestId: "update",
    },
    "writer",
  );
  assert.deepEqual((await backend.documents.sections()).items, [
    ...sections.items,
    { id: "one", name: "Новое имя" },
  ]);
  await backend.documents.changeSection(
    { action: "remove", id: "one", ifRevision: updated.revision, requestId: "remove" },
    "writer",
  );
  assert.equal((await backend.documents.sections()).total, sections.total);
});
