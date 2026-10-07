/**
 * A19/A20 (+A25 в другом процессе): реальное завершение дочернего процесса сигналом SIGKILL
 * в probe-точках публикации миграции и продолжение другим процессом. Повторное открытие и
 * чтение предметными сервисами выполняет третий процесс, чтобы успех не держался на кеше.
 * База — замороженная 43d683b с данными планирования v1 в формате 4 (меняются записи,
 * отношения, индексы и маркер).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { inspectPending } from "../src/storage/entity-store/transaction.js";
import {
  FIXTURES,
  diffTrees,
  persistent,
  planV1Format4,
  tempDir,
  treeHashes,
} from "./helpers/migration-bases.js";

const CHILD = new URL("./helpers/crash-child.mts", import.meta.url).pathname;
const CORE = new URL("..", import.meta.url).pathname;

type ChildResult = {
  status: number | null;
  signal: string | null;
  out: Record<string, unknown> | null;
};

function child(mode: string, args: unknown): Promise<ChildResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--conditions=tasks-source", "--import", "tsx", CHILD, mode, JSON.stringify(args)],
      { cwd: CORE, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        const line = stdout.trim().split("\n").filter(Boolean).at(-1);
        resolve({
          status: error ? ((error as { code?: number }).code ?? null) : 0,
          signal: error ? ((error as { signal?: string }).signal ?? null) : null,
          out: line ? (JSON.parse(line) as Record<string, unknown>) : null,
        });
      },
    );
  });
}

/** Постоянный предметный набор без runtime и служебной версии снимка индексов. */
const skip = (path: string) => persistent(path) || path === ".indexes/state.json";

test("A19/A20: SIGKILL в точках публикации, продолжение и чтение другими процессами", async (t) => {
  const oracle = JSON.parse(
    await readFile(join(FIXTURES, "physical2-plan-v1-43d683b", "oracle.json"), "utf8"),
  );
  // Эталон: непрерывный перенос копии той же базы.
  const reference = await planV1Format4(t);
  const done = await child("migrate", {
    configPath: reference.configPath,
    backupDir: await tempDir(t),
  });
  assert.equal(done.out?.ok, true, JSON.stringify(done.out));
  const expectedTree = await treeHashes(reference.root, skip);
  const expectedState = await child("read", { ...reference, oracle });
  assert.equal(expectedState.out?.ok, true, JSON.stringify(expectedState.out));

  const points = [
    { name: "до intent (A19)", kill: { stage: "staged" }, beforeIntent: true },
    { name: "после части сущностей", kill: { stage: "file", path: "entities/", nth: 2 } },
    { name: "после отношений", kill: { stage: "phase", path: "relations" } },
    { name: "после индексов", kill: { stage: "phase", path: "indexes" } },
    { name: "после manifest", kill: { stage: "phase", path: "manifest" } },
    { name: "до удаления WAL", kill: { stage: "published" } },
  ] as const;
  await Promise.all(
    points.map((point) =>
      t.test(point.name, async (t) => {
        const base = await planV1Format4(t);
        const original = await treeHashes(base.project);
        const backupDir = await tempDir(t);
        const killed = await child("migrate", {
          configPath: base.configPath,
          backupDir,
          kill: point.kill,
        });
        assert.equal(killed.signal, "SIGKILL", JSON.stringify(killed));
        // Следы убитого процесса в runtime — временные, не посторонние файлы.
        const afterKill = await child("status", { configPath: base.configPath });
        assert.ok(
          !JSON.stringify(afterKill.out).includes("STORAGE_FOREIGN_FILE"),
          JSON.stringify(afterKill.out),
        );
        const pending = await inspectPending(base.root);
        if ("beforeIntent" in point) {
          // A19: постоянный набор не изменён целиком; временные страницы и замок — только в runtime.
          assert.equal(pending.kind, "none");
          const changed = diffTrees(original, await treeHashes(base.project)).filter(
            (path) => !path.startsWith(".relay/runtime"),
          );
          assert.deepEqual(changed, []);
          const again = await child("migrate", {
            configPath: base.configPath,
            backupDir: await tempDir(t),
          });
          assert.equal(again.out?.ok, true, JSON.stringify(again.out));
        } else {
          assert.equal(pending.kind, "migration");
          // Другой процесс продолжает без --backup-dir, с проверкой backup из WAL.
          const resumed = await child("migrate", { configPath: base.configPath });
          assert.equal(resumed.out?.ok, true, JSON.stringify(resumed.out));
          const result = resumed.out!.result as {
            resumed: boolean;
            steps: unknown;
            counts: unknown;
          };
          const reference = done.out!.result as { steps: unknown; counts: unknown };
          assert.equal(result.resumed, true);
          assert.deepEqual(result.steps, reference.steps, "итог шагов из WAL");
          assert.deepEqual(result.counts, reference.counts, "счётчики из WAL");
        }
        assert.equal((await inspectPending(base.root)).kind, "none");
        // Временные копии атомарной записи и страницы миграции удалены продолжением.
        assert.deepEqual(
          (await readdir(join(base.root, "runtime"))).filter((name) => name !== ".gitignore"),
          [],
        );
        assert.equal((await readdir(backupDir)).length, 1, "исходный backup сохранён");
        assert.deepEqual(diffTrees(expectedTree, await treeHashes(base.root, skip)), []);
        const state = await child("read", { ...base, oracle });
        assert.equal(state.out?.ok, true, JSON.stringify(state.out));
        const strip = (value: unknown) => ({ ...(value as { state: object }).state, root: null });
        assert.deepEqual(strip(state.out), strip(expectedState.out));
      }),
    ),
  );
});
