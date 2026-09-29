import assert from "node:assert/strict";
import { allPages } from "./github-read.mjs";

const shaPattern = /^[0-9a-f]{40}$/;
const descriptor = (entry) =>
  entry ? { mode: entry.mode, type: entry.type, sha: entry.sha } : null;

/** Только GitHub GET: читаем Merkle-деревья, не загружаем/исполняем blobs и не переписываем Git. */
function gitReader(client, prefix) {
  const commits = new Map();
  const trees = new Map();
  return {
    async commit(sha) {
      assert.match(sha, shaPattern);
      if (!commits.has(sha)) {
        const data = await client.json(`${prefix}/git/commits/${sha}`);
        assert.equal(data.sha, sha, "API вернул другой Git commit");
        assert.match(data.tree?.sha ?? "", shaPattern);
        assert(Array.isArray(data.parents));
        for (const parent of data.parents) assert.match(parent.sha, shaPattern);
        assert(typeof data.message === "string");
        assert(typeof data.author?.name === "string" && typeof data.author?.email === "string");
        assert(Number.isFinite(Date.parse(data.author.date)), "Нет даты автора исходного коммита");
        commits.set(sha, {
          sha,
          tree: data.tree.sha,
          parents: data.parents.map((parent) => parent.sha),
          // Committer и подпись при rebase могут меняться; author и сообщение сохраняются.
          author: {
            name: data.author.name,
            email: data.author.email,
            date: Date.parse(data.author.date),
          },
          message: data.message,
        });
      }
      return commits.get(sha);
    },
    async tree(sha) {
      assert.match(sha, shaPattern);
      if (!trees.has(sha)) {
        // Без recursive=1: нельзя незаметно принять усечённое представление большого дерева.
        const data = await client.json(`${prefix}/git/trees/${sha}`);
        assert.equal(data.sha, sha, "API вернул другое Git tree");
        assert.equal(data.truncated, false, "Неполное Git tree не доказывает rebase");
        assert(Array.isArray(data.tree));
        const entries = new Map();
        for (const entry of data.tree) {
          assert(
            typeof entry.path === "string" &&
              entry.path &&
              !entry.path.includes("/") &&
              !entry.path.includes("\0"),
          );
          assert(!entries.has(entry.path), "Неоднозначный путь Git tree");
          assert.match(entry.sha, shaPattern);
          assert(
            (entry.type === "tree" && entry.mode === "040000") ||
              (entry.type === "blob" && ["100644", "100755", "120000"].includes(entry.mode)) ||
              (entry.type === "commit" && entry.mode === "160000"),
            "Неподдерживаемый объект Git tree",
          );
          entries.set(entry.path, descriptor(entry));
        }
        trees.set(sha, entries);
      }
      return trees.get(sha);
    },
  };
}

/** Точные переходы листьев, включая binary, executable, symlink и gitlink. Без эвристик patch-id. */
async function treeChanges(git, before, after) {
  const changes = [];
  async function visit(path, left, right) {
    if (left?.sha === right?.sha && left?.mode === right?.mode && left?.type === right?.type)
      return;
    if (left?.type === "tree" || right?.type === "tree") {
      const oldEntries = left?.type === "tree" ? await git.tree(left.sha) : new Map();
      const newEntries = right?.type === "tree" ? await git.tree(right.sha) : new Map();
      // Обычный Git не сохраняет пустые каталоги; не теряем необычные tree-объекты молча.
      if (path) {
        assert(
          left?.type !== "tree" || oldEntries.size,
          "Изменение пустого каталога не доказывается этим guard",
        );
        assert(
          right?.type !== "tree" || newEntries.size,
          "Изменение пустого каталога не доказывается этим guard",
        );
      }
      if (left && left.type !== "tree") changes.push({ path, before: left, after: null });
      if (right && right.type !== "tree") changes.push({ path, before: null, after: right });
      for (const name of [...new Set([...oldEntries.keys(), ...newEntries.keys()])].sort())
        await visit(
          path ? `${path}/${name}` : name,
          oldEntries.get(name) ?? null,
          newEntries.get(name) ?? null,
        );
    } else changes.push({ path, before: left, after: right });
  }
  await visit(
    "",
    { type: "tree", mode: "040000", sha: before },
    { type: "tree", mode: "040000", sha: after },
  );
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Доказывает только однозначный линейный перенос без пропущенных/объединённых коммитов.
 * API-связь merged PR -> tag SHA и финальный checked tree проверяет вызывающий admission.
 * Изменённые при переносе blobs требуют отдельного replay-доказательства и здесь запрещены.
 */
export async function verifyLinearRebase({ client, prefix, pr, commit, testedBase }) {
  assert(
    Number.isSafeInteger(pr.commits) && pr.commits > 1,
    "Нет полного состава PR для доказательства многокоммитного rebase",
  );
  const listed = await allPages(client, `${prefix}/pulls/${pr.number}/commits`);
  assert.equal(
    listed.length,
    pr.commits,
    "API вернул неполный список PR-коммитов; rebase не доказан",
  );
  const originalIds = new Set();
  for (const entry of listed) {
    assert.match(entry.sha, shaPattern);
    assert(!originalIds.has(entry.sha), "Повторяющийся PR-коммит");
    originalIds.add(entry.sha);
  }
  const git = gitReader(client, prefix);
  const original = [];
  let cursor = pr.head.sha;
  for (let index = 0; index < listed.length; index++) {
    assert(originalIds.delete(cursor), "Список PR-коммитов не образует одну цепочку до final head");
    const entry = await git.commit(cursor);
    assert.equal(entry.parents.length, 1, "Исходная история PR нелинейна; rebase не доказан");
    original.unshift(entry);
    cursor = entry.parents[0];
  }
  assert.equal(originalIds.size, 0);
  assert(!listed.some((entry) => entry.sha === cursor), "Цикл в исходной истории PR");

  const rewritten = [];
  const rewrittenIds = new Set();
  cursor = commit.sha;
  for (let index = 0; index < listed.length; index++) {
    assert(
      cursor !== testedBase && !rewrittenIds.has(cursor),
      "Число переписанных PR-коммитов отличается",
    );
    rewrittenIds.add(cursor);
    const entry = await git.commit(cursor);
    assert.equal(entry.parents.length, 1, "Результирующая цепочка нелинейна; rebase не доказан");
    rewritten.unshift(entry);
    cursor = entry.parents[0];
  }
  assert.equal(
    cursor,
    testedBase,
    "Rebase выполнен не от точного tested base (stale base или другая цепочка)",
  );
  assert.equal(rewritten.at(-1).tree, commit.tree, "Git API tree tag SHA отличается от checkout");
  assert.deepEqual(
    rewritten.at(-1).parents,
    commit.parents,
    "Git API родители tag SHA отличаются от checkout",
  );
  for (let index = 0; index < original.length; index++) {
    const source = original[index];
    const target = rewritten[index];
    assert.deepEqual(target.author, source.author, `Rebase: другой автор коммита ${index + 1}`);
    assert.equal(target.message, source.message, `Rebase: другое сообщение коммита ${index + 1}`);
    const sourceParent = await git.commit(source.parents[0]);
    const targetParent = await git.commit(target.parents[0]);
    assert.deepEqual(
      await treeChanges(git, targetParent.tree, target.tree),
      await treeChanges(git, sourceParent.tree, source.tree),
      `Rebase: точные изменения коммита ${index + 1} не совпадают; перенос с изменением blobs требует отдельного доказательства`,
    );
  }
  return rewritten.length;
}
