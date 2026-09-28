import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fixture, successful, failed, invokeRaw } from "./helpers/cli.js";

type Detail = {
  key: string;
  ref: { id: string };
  revision: number;
  document?: { sectionId: string | null };
  data: {
    name: string;
    summary: string;
    body: string;
    documentKind: string;
    documentStatus: string;
    sectionId: string | null;
    pinned: boolean;
    links: unknown[];
    relations: { type: string; target: { id: string }; description?: string }[];
  };
};
type Sections = { revision: number; items: { id: string; name: string }[] };
const markdown =
  "## Решение\n\nПолный документ 🧭.\n\n- Сохранить основания\n\n```text\n  точный отступ\n```\n\nПоследний абзац документа.\n";

test("document link/unlink: независимый граф, направление и сохранение соседнего документа", async (t) => {
  const app = await fixture(t);
  type Address = { kind: string; id: string };
  type Graph = {
    complete?: boolean;
    nodes: { ref: Address }[];
    edges: { from: Address; to: Address; type: string }[];
  };
  const create = async (kind: string, name: string) =>
    successful(
      await app.run<{ key: string; ref: Address }>([
        kind,
        "create",
        "--name",
        name,
        kind === "document" ? "--body" : "--description",
        markdown,
      ]),
    ).data;
  const target = await create("feature", "Цель");
  const neighbor = await create("feature", "Соседняя цель");
  const doc = await create("document", "Материал");
  const otherDoc = await create("document", "Соседний материал");
  const read = async (key: string) =>
    successful(await app.run<Detail>(["document", "get", key])).data;
  const change = async (action: string, key: string, targetKey: string, relation: string) => {
    const before = await read(key);
    successful(
      await app.run([
        "document",
        action,
        key,
        "--target",
        targetKey,
        "--relation",
        relation,
        "--if-revision",
        before.revision,
      ]),
    );
  };
  const signature = (edge: Graph["edges"][number]) =>
    `${edge.from.kind}:${edge.from.id}|${edge.type}|${edge.to.kind}:${edge.to.id}`;
  const graph = async () => {
    const page = successful(await app.run<Graph>(["inspect", "graph", "list", "--limit", 100]));
    assert.equal(page.meta?.page?.nextCursor, null);
    return page.data;
  };
  await change("link", otherDoc.key, neighbor.key, "documents");
  await change("link", doc.key, neighbor.key, "documents");
  const otherBefore = await read(otherDoc.key);
  const initial = await graph();
  let expected = initial.edges.map(signature).sort();
  const reference = signature({ from: target.ref, to: doc.ref, type: "references" });
  const documents = signature({ from: doc.ref, to: target.ref, type: "documents" });
  for (const [action, relation, selected] of [
    ["link", "references", reference],
    ["link", "documents", documents],
    ["unlink", "references", reference],
    ["unlink", "documents", documents],
  ] as const)
    await t.test(`${action} ${relation}: меняется только выбранное ребро`, async () => {
      await change(action, doc.key, target.key, relation);
      expected =
        action === "link"
          ? [...expected, selected].sort()
          : expected.filter((edge) => edge !== selected);
      const actual = await graph();
      assert.deepEqual(actual.edges.map(signature).sort(), expected);
      assert.deepEqual(
        actual.nodes.map((node) => `${node.ref.kind}:${node.ref.id}`).sort(),
        initial.nodes.map((node) => `${node.ref.kind}:${node.ref.id}`).sort(),
      );
      const context = successful(
        await app.run<Graph>(["inspect", "graph", "context", doc.key]),
      ).data;
      assert.equal(context.complete, true);
      assert.deepEqual(context.edges.map(signature).sort(), expected);
      for (const ref of [doc.ref, otherDoc.ref, target.ref, neighbor.ref])
        assert.ok(
          context.nodes.some((node) => node.ref.id === ref.id && node.ref.kind === ref.kind),
        );
      assert.deepEqual(await read(otherDoc.key), otherBefore);
      const saved = await read(doc.key);
      assert.equal(saved.ref.id, doc.ref.id);
      assert.equal(saved.data.body, markdown);
      assert.ok(
        saved.data.relations.some(
          (link) => link.target.id === neighbor.ref.id && link.type === "documents",
        ),
      );
    });
});

test("document: восемь листьев, богатый документ и независимые формы прикрепления", async (t) => {
  const app = await fixture(t);
  const target = successful(
    await app.run<{ key: string; ref: { id: string } }>([
      "feature",
      "create",
      "--name",
      "Поиск",
      "--description",
      "Требования",
    ]),
  ).data;
  const neighbor = successful(
    await app.run<{ key: string; ref: { id: string } }>([
      "feature",
      "create",
      "--name",
      "Сосед",
      "--description",
      "Не терять",
    ]),
  ).data;
  const legacy = successful(
    await app.run<{ key: string }>([
      "feature",
      "create",
      "--name",
      "Прежняя область",
      "--description",
      "Совместимость",
    ]),
  ).data;
  let key = "";
  const read = async () => successful(await app.run<Detail>(["document", "get", key])).data;
  const file = join(app.root, "решение команды.md");
  await writeFile(file, markdown);
  await t.test("create: файл, metadata и legacy targets", async () => {
    key = successful(
      await app.run<{ key: string }>([
        "document",
        "create",
        "--name",
        "Основания поиска",
        "--summary",
        "Когда читать\nЗачем читать",
        "--body-file",
        file,
        "--document-kind",
        "proposal",
        "--document-status",
        "draft",
        "--pinned",
        "true",
        "--targets",
        legacy.key,
        neighbor.key,
      ]),
    ).data.key;
    const record = await read();
    assert.equal(record.data.body, markdown);
    assert.equal(record.data.documentKind, "proposal");
    assert.equal(record.data.pinned, true);
    assert.equal(record.data.links.length, 2);
  });
  await t.test("get: полное содержание в JSON и human 40/100", async () => {
    for (const width of [40, 100]) {
      const out = await invokeRaw(app.root, ["document", "get", key], {
        env: { COLUMNS: String(width), FORCE_COLOR: "1" },
      });
      assert.equal(out.code, 0, out.stdout);
      assert.equal(out.stderr, "");
      for (const text of [
        key,
        "Основания поиска",
        "## Решение",
        "  точный отступ",
        "Последний абзац документа.",
      ])
        assert.ok(out.stdout.includes(text), out.stdout);
      assert.match(out.stdout, /ревизия/i);
      assert.doesNotMatch(out.stdout, /\u001b|"data":|\\n/);
    }
  });
  await t.test(
    "update: no-op/конфликт источников безопасны, metadata не стирает body",
    async () => {
      const before = await read();
      for (const fields of [
        [],
        ["--body", "Нет", "--body-file", file],
        ["--summary-file", "-", "--body-file", "-"],
        ["--targets", target.key, "--clear-targets"],
        ["--section-id", "x", "--clear-section"],
      ]) {
        const result = await app.run(
          ["document", "update", key, "--if-revision", before.revision, ...fields],
          { input: "Нельзя записать" },
        );
        assert.equal(result.body.ok, false, result.stdout);
        assert.deepEqual(await read(), before);
      }
      successful(
        await app.run([
          "document",
          "update",
          key,
          "--document-kind",
          "decision",
          "--document-status",
          "active",
          "--pinned",
          "false",
          "--if-revision",
          before.revision,
        ]),
      );
      failed(
        await app.run([
          "document",
          "update",
          key,
          "--name",
          "Не записывать",
          "--if-revision",
          before.revision,
        ]),
        "REVISION_CONFLICT",
        4,
      );
      const current = await read();
      assert.equal(current.data.documentKind, "decision");
      assert.equal(current.data.documentStatus, "active");
      assert.equal(current.data.pinned, false);
      assert.equal(current.data.body, markdown);
      assert.equal(current.data.summary, before.data.summary);
      assert.deepEqual(current.data.links, before.data.links);
    },
  );
  await t.test("link: references/documents одной цели, сосед и пояснение без потерь", async () => {
    for (const [ref, relation] of [
      [target.key, "references"],
      [target.key, "documents"],
      [neighbor.key, "references"],
    ]) {
      const before = await read();
      successful(
        await app.run([
          "document",
          "link",
          key,
          "--target",
          ref!,
          "--relation",
          relation!,
          "--description",
          "## Основание\n\nПолное пояснение.\n",
          "--if-revision",
          before.revision,
        ]),
      );
      assert.deepEqual((await read()).data.links, before.data.links);
    }
    let record = await read();
    assert.equal(record.data.relations.length, 3);
    successful(
      await app.run([
        "document",
        "link",
        key,
        "--target",
        target.key,
        "--relation",
        "references",
        "--if-revision",
        record.revision,
      ]),
    );
    assert.deepEqual((await read()).data.relations, record.data.relations);
    record = await read();
    successful(
      await app.run(
        [
          "document",
          "link",
          key,
          "--target",
          target.key,
          "--relation",
          "references",
          "--description-file",
          "-",
          "--if-revision",
          record.revision,
        ],
        { input: "Изменённое пояснение.\n" },
      ),
    );
    record = await read();
    assert.equal(record.data.relations.length, 3);
    assert.equal(
      record.data.relations.find(
        (link) => link.target.id === target.ref.id && link.type === "references",
      )?.description,
      "Изменённое пояснение.\n",
    );
    failed(
      await app.run([
        "document",
        "link",
        key,
        "--target",
        target.key,
        "--legacy",
        "--relation",
        "references",
        "--if-revision",
        record.revision,
      ]),
      "INVALID_ARGUMENT",
    );
    assert.deepEqual(await read(), record);
  });
  await t.test("links: отдельные source/types, ревизия и cursor", async () => {
    const first = successful(
      await app.run<{ items: { source: string; type: string }[]; total: number; revision: number }>(
        ["document", "links", key, "--limit", 2],
      ),
    );
    assert.equal(first.data.total, 5);
    assert.equal(first.data.revision, (await read()).revision);
    assert.equal(first.meta?.page?.consistency, "snapshot");
    assert.ok(first.meta?.page?.nextCursor);
    const all = successful(
      await app.run<{ items: { source: string; type: string }[] }>(["document", "links", key]),
    ).data.items;
    assert.equal(all.filter((item) => item.source === "links").length, 2);
    assert.equal(all.filter((item) => item.source === "relations").length, 3);
    assert.deepEqual(new Set(all.map((item) => item.type)), new Set(["documents", "references"]));
    const next = successful(
      await app.run<{ items: unknown[] }>([
        "document",
        "links",
        key,
        "--cursor",
        first.meta!.page!.nextCursor!,
      ]),
    );
    assert.notDeepEqual(next.data.items, first.data.items);
    const human = await invokeRaw(app.root, ["document", "links", key]);
    assert.equal(human.code, 0, human.stdout);
    assert.match(human.stdout, /Изменённое пояснение/);
    assert.match(human.stdout, /Полное пояснение/);
    assert.match(human.stdout, /ссыл|материал|references/i);
    assert.match(human.stdout, /опис|документ|documents/i);
    assert.doesNotMatch(human.stdout, /\u001b/);
  });
  await t.test("unlink: снимает только выбранный тип/форму и сохраняет соседей", async () => {
    let before = await read();
    successful(
      await app.run([
        "document",
        "unlink",
        key,
        "--target",
        target.key,
        "--relation",
        "references",
        "--if-revision",
        before.revision,
      ]),
    );
    let after = await read();
    assert.deepEqual(after.data.links, before.data.links);
    assert.deepEqual(
      after.data.relations,
      before.data.relations.filter(
        (link) => !(link.target.id === target.ref.id && link.type === "references"),
      ),
    );
    failed(
      await app.run([
        "document",
        "unlink",
        key,
        "--target",
        target.key,
        "--relation",
        "references",
        "--if-revision",
        after.revision,
      ]),
      "INVALID_ARGUMENT",
    );
    before = after;
    successful(
      await app.run([
        "document",
        "unlink",
        key,
        "--target",
        neighbor.key,
        "--legacy",
        "--if-revision",
        before.revision,
      ]),
    );
    after = await read();
    assert.deepEqual(after.data.relations, before.data.relations);
    assert.equal(after.data.links.length, 1);
    assert.equal(after.data.body, markdown);
    successful(
      await app.run([
        "document",
        "update",
        key,
        "--clear-relations",
        "--clear-summary",
        "--if-revision",
        after.revision,
      ]),
    );
    after = await read();
    assert.equal(after.data.relations.length, 0);
    assert.equal(after.data.links.length, 1);
    assert.equal(after.data.summary, "");
  });
  await t.test("rename: aliases и ID документа", async () => {
    const before = await read();
    successful(
      await app.run(["document", "rename", key, "SEARCH-RULES", "--if-revision", before.revision]),
    );
    const after = await read();
    assert.equal(after.key, "SEARCH-RULES");
    assert.equal(after.ref.id, before.ref.id);
    assert.deepEqual(after.data, before.data);
    key = after.key;
  });
  await t.test("list: фильтры metadata и цели применяются до пагинации", async () => {
    const current = await read();
    successful(
      await app.run([
        "document",
        "update",
        key,
        "--name",
        "B Основания",
        "--if-revision",
        current.revision,
      ]),
    );
    const second = successful(
      await app.run<{ key: string }>([
        "document",
        "create",
        "--name",
        "A Основания",
        "--body",
        "Второй документ",
        "--document-kind",
        "decision",
        "--document-status",
        "active",
        "--pinned",
        "false",
        "--targets",
        legacy.key,
      ]),
    ).data;
    const sections = successful(await app.run<Sections>(["document", "section", "list"])).data;
    const decoys: { key: string; title: string }[] = [];
    for (const [title, kind, status, pinned, targetRef, section] of [
      ["C Основания", "rules", "active", "false", legacy.key, ""],
      ["D Основания", "decision", "draft", "false", legacy.key, ""],
      ["E Основания", "decision", "active", "true", legacy.key, ""],
      ["F Основания", "decision", "active", "false", neighbor.key, ""],
      ["G Основания", "decision", "active", "false", legacy.key, sections.items[0]!.id],
      ["H Основания", "decision", "archived", "false", legacy.key, ""],
      ["I Посторонний", "decision", "active", "false", legacy.key, ""],
    ]) {
      const saved = successful(
        await app.run<{ key: string }>([
          "document",
          "create",
          "--name",
          title!,
          "--body",
          "Содержание",
          "--document-kind",
          kind!,
          "--document-status",
          status!,
          "--pinned",
          pinned!,
          "--targets",
          targetRef!,
          ...(section ? ["--section-id", section] : []),
        ]),
      ).data;
      decoys.push({ key: saved.key, title: title! });
    }
    const first = successful(
      await app.run<{ total: number; items: { key: string }[] }>([
        "document",
        "list",
        "--q",
        "Основания",
        "--document-kind",
        "decision",
        "--status",
        "active",
        "--section",
        "none",
        "--pinned",
        "false",
        "--archived",
        "false",
        "--target",
        legacy.key,
        "--sort",
        "title",
        "--limit",
        1,
      ]),
    );
    assert.equal(first.data.total, 2);
    assert.ok(first.meta?.page?.nextCursor);
    const next = successful(
      await app.run<{ items: { key: string }[] }>([
        "document",
        "list",
        "--cursor",
        first.meta!.page!.nextCursor!,
      ]),
    );
    assert.deepEqual(
      [...first.data.items, ...next.data.items].map((item) => item.key),
      [second.key, key],
    );
    assert.equal(next.meta?.page?.nextCursor, null);
    for (const [args, expectedKey, title] of [
      [
        [
          "document",
          "list",
          "--q",
          "Основания",
          "--document-kind",
          "decision",
          "--status",
          "active",
          "--section",
          "none",
          "--pinned",
          "false",
          "--archived",
          "false",
          "--target",
          legacy.key,
          "--sort",
          "title",
          "--limit",
          "1",
        ],
        second.key,
        "A Основания",
      ],
      [["document", "list", "--cursor", first.meta!.page!.nextCursor!], key, "B Основания"],
    ] as const) {
      const human = await invokeRaw(app.root, [...args]);
      assert.equal(human.code, 0, human.stdout);
      const text = human.stdout.replace(/\s+/g, " ");
      for (const value of [expectedKey, title, "Действующий", "Решение"])
        assert.ok(text.includes(value), text);
      for (const [label, value] of [
        ["Поиск", "Основания"],
        ["Тип документа", "decision"],
        ["Состояние", "Действующий"],
        ["Раздел", "none"],
        ["Закрепление", "false"],
        ["Архив", "false"],
        ["Цель", legacy.key],
        ["Сортировка", "title"],
      ])
        assert.match(text, new RegExp(`${label}:\\s*${value}`));
      assert.equal((human.stdout.match(/Показано:/g) ?? []).length, 1);
      assert.match(text, /Показано: 1 из 2/);
      if (expectedKey === second.key)
        assert.match(human.stdout, /npx @oim-dev\/relay-cli .*document list .*--cursor/);
      else assert.match(human.stdout, /Конец списка/);
    }
    // Архив проверяется отдельно от status, иначе active маскирует игнорирование archived.
    for (const [archived, expected] of [
      ["true", [decoys[5]!]],
      [
        "false",
        [
          { key: second.key, title: "A Основания" },
          { key, title: "B Основания" },
          ...decoys.slice(0, 5),
        ],
      ],
    ] as const) {
      let args: Array<string | number> = [
        "document",
        "list",
        "--q",
        "Основания",
        "--archived",
        archived,
        "--sort",
        "title",
        "--limit",
        2,
      ];
      const keys: string[] = [];
      do {
        const page = successful(
          await app.run<{ total: number; items: { key: string; title: string }[] }>(args),
        );
        assert.equal(page.data.total, expected.length);
        assert.deepEqual(
          page.data.items.map(({ key, title }) => ({ key, title })),
          expected.slice(keys.length, keys.length + 2),
        );
        keys.push(...page.data.items.map((item) => item.key));
        const cursor = page.meta?.page?.nextCursor;
        if (!cursor) {
          assert.equal(page.meta?.page?.nextCursor, null);
          break;
        }
        assert.ok(keys.length < expected.length);
        args = ["document", "list", "--cursor", cursor];
      } while (true);
      assert.deepEqual(
        keys,
        expected.map((item) => item.key),
      );
    }
  });
});

test("document section: пять листьев, порядок, guards и сохранение документов", async (t) => {
  const app = await fixture(t);
  const read = async () =>
    successful(await app.run<Sections>(["document", "section", "list"])).data;
  let sections = await read();
  const initial = sections.items;
  const writeSection = async (
    action: "create" | "update" | "move" | "remove",
    args: string[],
    revision: number,
  ) => {
    const human = await invokeRaw(app.root, [
      "document",
      "section",
      action,
      "guides",
      ...args,
      "--if-revision",
      revision,
    ]);
    assert.equal(human.code, 0, human.stdout);
    assert.equal(human.stderr, "");
    const text = human.stdout.replace(/\s+/g, " ");
    const verb = { create: "Создан", update: "Переименован", move: "Перемещён", remove: "Удалён" }[
      action
    ];
    assert.ok(text.includes(`${verb} раздел guides`), text);
    assert.ok(text.includes("PROJECT"), text);
    assert.match(text, new RegExp(`Ревизия проекта:\\s*${revision + 1}\\b`));
    assert.match(human.stdout, /npx @oim-dev\/relay-cli .*document section list/);
    assert.doesNotMatch(human.stdout, /\u001b|"data":/);
  };
  await t.test("list: порядок и ревизия PROJECT", async () => {
    const page = successful(await app.run<Sections>(["document", "section", "list", "--limit", 1]));
    assert.equal(page.data.revision, sections.revision);
    assert.equal(page.meta?.page?.consistency, "snapshot");
    assert.deepEqual(page.data.items, initial.slice(0, 1));
    const human = await invokeRaw(app.root, ["document", "section", "list", "--limit", 1]);
    assert.equal(human.code, 0, human.stdout);
    const text = human.stdout.replace(/\s+/g, " ");
    for (const value of [initial[0]!.id, initial[0]!.name]) assert.ok(text.includes(value), text);
    assert.match(text, new RegExp(`Ревизия проекта:\\s*${sections.revision}\\b`));
    assert.equal((human.stdout.match(/Показано:/g) ?? []).length, 1);
    assert.match(text, new RegExp(`Показано: 1 из ${initial.length}\\b`));
    assert.match(human.stdout, /npx @oim-dev\/relay-cli .*document section list .*--cursor/);
  });
  await t.test("create: добавляет в конец, stale/duplicate безопасны", async () => {
    await writeSection("create", ["--name", "Руководства"], sections.revision);
    failed(
      await app.run([
        "document",
        "section",
        "create",
        "lost",
        "--name",
        "Не создавать",
        "--if-revision",
        sections.revision,
      ]),
      "REVISION_CONFLICT",
      4,
    );
    sections = await read();
    assert.deepEqual(sections.items, [...initial, { id: "guides", name: "Руководства" }]);
    failed(
      await app.run([
        "document",
        "section",
        "create",
        "guides",
        "--name",
        "Дубль",
        "--if-revision",
        sections.revision,
      ]),
      "INVALID_ARGUMENT",
    );
    assert.deepEqual(await read(), sections);
  });
  await t.test("update: ID и соседние разделы сохранены", async () => {
    await writeSection("update", ["--name", "Инструкции"], sections.revision);
    sections = await read();
    assert.deepEqual(sections.items, [...initial, { id: "guides", name: "Инструкции" }]);
  });
  await t.test("move: before и last; конфликт параметров/self/unknown не пишет", async () => {
    for (const options of [
      [],
      ["--before", "guides"],
      ["--before", "unknown"],
      ["--before", initial[0]!.id, "--last"],
    ]) {
      failed(
        await app.run([
          "document",
          "section",
          "move",
          "guides",
          "--if-revision",
          sections.revision,
          ...options,
        ]),
        "INVALID_ARGUMENT",
      );
      assert.deepEqual(await read(), sections);
    }
    await writeSection("move", ["--before", initial[0]!.id], sections.revision);
    sections = await read();
    assert.equal(sections.items[0]!.id, "guides");
    await writeSection("move", ["--last"], sections.revision);
    sections = await read();
    assert.equal(sections.items.at(-1)!.id, "guides");
  });
  await t.test(
    "remove: эффективный раздел, RAW и ревизия документа, фильтры и snapshot",
    async () => {
      const doc = successful(
        await app.run<{ key: string }>([
          "document",
          "create",
          "--name",
          "Инструкция",
          "--body",
          markdown,
          "--section-id",
          "guides",
        ]),
      ).data;
      successful(
        await app.run([
          "document",
          "create",
          "--name",
          "Соседняя инструкция",
          "--body",
          "Сохранить соседний документ.",
          "--section-id",
          "guides",
        ]),
      );
      const before = successful(await app.run<Detail>(["document", "get", doc.key])).data;
      assert.ok(before.document);
      assert.equal(before.document.sectionId, "guides");
      assert.equal(before.data.sectionId, "guides");
      const oldPage = successful(
        await app.run<{ total: number; items: { key: string }[] }>([
          "document",
          "list",
          "--section",
          "guides",
          "--limit",
          1,
        ]),
      );
      assert.equal(oldPage.data.total, 2);
      assert.equal(oldPage.data.items.length, 1);
      assert.equal(oldPage.meta?.page?.consistency, "snapshot");
      const cursor = oldPage.meta?.page?.nextCursor;
      assert.ok(cursor);
      const unsectionedBefore = successful(
        await app.run<{ items: { key: string }[] }>(["document", "list", "--section", "none"]),
      ).data;
      assert.ok(!unsectionedBefore.items.some((item) => item.key === doc.key));
      sections = await read();
      await writeSection("remove", [], sections.revision);
      const sectionsAfter = await read();
      assert.deepEqual(sectionsAfter.items, initial);
      assert.equal(sectionsAfter.revision, sections.revision + 1);
      const after = successful(await app.run<Detail>(["document", "get", doc.key])).data;
      assert.deepEqual(after.ref, before.ref);
      assert.equal(after.key, before.key);
      assert.equal(after.revision, before.revision);
      assert.ok(after.document);
      assert.equal(after.document.sectionId, null);
      // Удаление раздела меняет проекцию, но не переписывает сохранённый документ.
      assert.equal(after.data.sectionId, "guides");
      assert.deepEqual(after.data, before.data);
      assert.equal(after.data.body, markdown);
      const unsectionedAfter = successful(
        await app.run<{ total: number; items: { key: string }[] }>([
          "document",
          "list",
          "--section",
          "none",
        ]),
      ).data;
      assert.equal(unsectionedAfter.total, 2);
      assert.ok(unsectionedAfter.items.some((item) => item.key === doc.key));
      const removedSection = successful(
        await app.run<{ total: number; items: { key: string }[] }>([
          "document",
          "list",
          "--section",
          "guides",
        ]),
      ).data;
      assert.equal(removedSection.total, 0);
      assert.deepEqual(removedSection.items, []);
      const stale = await app.run(["document", "list", "--cursor", cursor]);
      assert.notEqual(stale.code, 0);
      assert.equal(stale.stderr, "");
      assert.equal(stale.body.ok, false, stale.stdout);
      if (!stale.body.ok) assert.equal(stale.body.error.code, "ENTITIES_CHANGED");
    },
  );
});
