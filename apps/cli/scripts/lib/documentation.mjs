import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import GithubSlugger from "github-slugger";

/** @typedef {import('mdast').Root | import('mdast').RootContent} MarkdownNode */
/** @typedef {import('mdast').Link | import('mdast').Image | import('mdast').Definition} Destination */

/** @param {MarkdownNode} node @param {(node: MarkdownNode) => void} visitor */
function visit(node, visitor) {
  visitor(node);
  if ("children" in node) for (const child of node.children) visit(child, visitor);
}

/** @param {MarkdownNode} node @returns {string} */
function headingText(node) {
  if (node.type === "html") return "";
  if ("value" in node) return node.value;
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  return "children" in node ? node.children.map(headingText).join("") : "";
}

/** Разбирает настоящие ссылки, исключая примеры Markdown внутри блоков кода.
 * @param {string} markdown
 */
export function inspectMarkdown(markdown) {
  const root = fromMarkdown(markdown);
  const slugger = new GithubSlugger();
  const anchors = new Set();
  /** @type {Destination[]} */
  const destinations = [];
  const imageDefinitions = new Set();
  visit(root, (node) => {
    if (node.type === "heading") anchors.add(slugger.slug(headingText(node)));
    if (node.type === "html") {
      for (const match of node.value.matchAll(/\b(?:id|name)=["']([^"']+)["']/g))
        anchors.add(match[1]);
    }
    if (node.type === "link" || node.type === "image" || node.type === "definition")
      destinations.push(node);
    if (node.type === "imageReference") imageDefinitions.add(node.identifier);
  });
  return { root, anchors, destinations, imageDefinitions };
}

/** @param {string} source @param {string} url */
function localTarget(source, url) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) return undefined;
  const match = /^([^?#]*)([^#]*)(?:#(.*))?$/.exec(url);
  assert(match);
  const pathname = decodeURIComponent(match[1] ?? "");
  const target = pathname
    ? posix.normalize(
        pathname.startsWith("/") ? pathname.slice(1) : posix.join(posix.dirname(source), pathname),
      )
    : source;
  assert(target !== ".." && !target.startsWith("../"), `Ссылка вне репозитория: ${source}: ${url}`);
  return {
    target,
    suffix: (match[2] ?? "") + (match[3] === undefined ? "" : `#${match[3]}`),
    anchor: match[3] === undefined ? undefined : decodeURIComponent(match[3]),
  };
}

/** @param {string} directory @returns {Promise<string[]>} */
export async function filesBelow(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const child of await filesBelow(join(directory, entry.name)))
        result.push(`${entry.name}/${child}`);
    } else if (entry.isFile()) result.push(entry.name);
  }
  return result.sort();
}

/** Исключает технические каталоги, сохраняя тематические разделы выбранных источников.
 * @param {string} name
 */
function documentationDirectory(name) {
  return !name.startsWith(".") && !["node_modules", "dist", "coverage"].includes(name);
}

/** Обходит только выбранное дерево документации, не переходя по симлинкам.
 * @param {string} directory @returns {Promise<string[]>}
 */
async function documentationBelow(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && documentationDirectory(entry.name)) {
      for (const child of await documentationBelow(join(directory, entry.name)))
        result.push(`${entry.name}/${child}`);
    } else if (entry.isFile() && entry.name.endsWith(".md")) result.push(entry.name);
  }
  return result.sort();
}

/** Пользовательские документы и инструкции владельцев, без общего обхода исходников и данных.
 * @param {string} root
 */
export async function documentationFiles(root) {
  const result = ["README.md", "AGENTS.md"];
  for (const directory of ["docs", "scripts"])
    for (const path of await documentationBelow(join(root, directory)))
      result.push(`${directory}/${path}`);
  for (const scope of ["apps", "packages"]) {
    for (const workspace of await readdir(join(root, scope), { withFileTypes: true })) {
      if (!workspace.isDirectory() || !documentationDirectory(workspace.name)) continue;
      const base = `${scope}/${workspace.name}`;
      for (const entry of await readdir(join(root, base), { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) result.push(`${base}/${entry.name}`);
        if (entry.isDirectory() && entry.name === "docs")
          for (const child of await documentationBelow(join(root, base, "docs")))
            result.push(`${base}/docs/${child}`);
        // У скилла есть виртуальные ссылки: его src проверяется сборщиком, не этим обходом.
        if (
          scope === "packages" &&
          workspace.name === "dev-agents" &&
          entry.isDirectory() &&
          entry.name === "src"
        )
          for (const child of await documentationBelow(join(root, base, "src")))
            result.push(`${base}/src/${child}`);
      }
    }
  }
  return result.filter((path) => path.endsWith(".md")).sort();
}

/** @param {string} root @param {string[]} paths */
export async function checkDocumentation(root, paths) {
  /** @type {Map<string, ReturnType<typeof inspectMarkdown>>} */
  const documents = new Map();
  /** @param {string} path */
  async function document(path) {
    if (!documents.has(path))
      documents.set(path, inspectMarkdown(await readFile(join(root, path), "utf8")));
    return documents.get(path);
  }
  const errors = [];
  let links = 0;
  for (const path of paths) {
    for (const node of (await document(path))?.destinations ?? []) {
      links++;
      try {
        const local = localTarget(path, node.url);
        if (!local) continue;
        const target = await stat(join(root, local.target));
        if (local.anchor && target.isFile() && local.target.endsWith(".md")) {
          assert(
            (await document(local.target))?.anchors.has(local.anchor),
            `Нет якоря #${local.anchor} в ${local.target}`,
          );
        }
      } catch (error) {
        errors.push(`${path}:${node.position?.start.line ?? 1}: ${node.url}: ${String(error)}`);
      }
    }
  }
  assert.equal(errors.length, 0, `Ошибки документации:\n${errors.join("\n")}`);
  return { documents: paths.length, links };
}

/** Находит только адрес ссылки, сохраняя подпись, title и остальное форматирование.
 * @param {string} markdown @param {Destination} node
 */
function destinationRange(markdown, node) {
  const offset = node.position?.start.offset;
  const end = node.position?.end.offset;
  assert(offset !== undefined && end !== undefined);
  const fragment = markdown.slice(offset, end);
  // У ссылки конец последнего дочернего узла предшествует её закрывающей скобке.
  // Это сохраняет вложенные картинки и title, содержащий буквальное «](».
  const labelEnd =
    node.type === "link" ? (node.children.at(-1)?.position?.end.offset ?? offset + 1) - offset : 0;
  const marker =
    node.type === "definition" ? fragment.indexOf("]:") : fragment.indexOf("](", labelEnd);
  assert(marker >= 0, `Не удалось найти адрес ссылки: ${fragment}`);
  let start = offset + marker + 2;
  while (/\s/.test(markdown[start] ?? "")) start++;
  if (markdown[start] === "<") {
    start++;
    const finish = markdown.indexOf(">", start);
    assert(finish >= start && finish < end);
    return { start, end: finish };
  }
  let cursor = start;
  let parentheses = 0;
  while (cursor < end) {
    const character = markdown[cursor];
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === "(") parentheses++;
    if (character === ")") {
      if (parentheses === 0) break;
      parentheses--;
    }
    if (/\s/.test(character ?? "")) break;
    cursor++;
  }
  return { start, end: cursor };
}

/** @param {string} path */
const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

/** Переписывает адреса Markdown-ссылок, сохраняя подписи и не затрагивая примеры кода.
 * @param {string} markdown
 * @param {(url: string, node: Destination) => string} rewrite
 */
export function rewriteMarkdownLinks(markdown, rewrite) {
  const changes = inspectMarkdown(markdown).destinations.flatMap((node) => {
    const url = rewrite(node.url, node);
    return url === node.url ? [] : [{ ...destinationRange(markdown, node), url }];
  });
  for (const change of changes.sort((left, right) => right.start - left.start))
    markdown = markdown.slice(0, change.start) + change.url + markdown.slice(change.end);
  return markdown;
}

/** README npm использует абсолютные адреса; включённые документы сохраняют локальную навигацию.
 * @param {{root: string, source: string, markdown: string, version: string,
 *   files: ReadonlyMap<string, string>, absolute?: boolean}} options
 */
export async function packageMarkdown({
  root,
  source,
  markdown,
  version,
  files,
  absolute = false,
}) {
  const parsed = inspectMarkdown(markdown);
  const changes = [];
  for (const node of parsed.destinations) {
    if (node.url.startsWith("#")) continue;
    const local = localTarget(source, node.url);
    if (!local) continue;
    const image =
      node.type === "image" ||
      (node.type === "definition" && parsed.imageDefinitions.has(node.identifier));
    const included = files.get(local.target);
    let url;
    if (!absolute && included !== undefined) {
      const current = files.get(source);
      assert(current !== undefined);
      url = encodePath(posix.relative(posix.dirname(current), included)) + local.suffix;
    } else {
      const path = encodePath(local.target);
      const tag = encodeURIComponent(`v${version}`);
      const kind = (await stat(join(root, local.target))).isDirectory() ? "tree" : "blob";
      url = image
        ? `https://raw.githubusercontent.com/oim-dev/relay/${tag}/${path}${local.suffix}`
        : `https://github.com/oim-dev/relay/${kind}/${tag}/${path}${local.suffix}`;
    }
    changes.push({ ...destinationRange(markdown, node), url });
  }
  for (const change of changes.sort((a, b) => b.start - a.start))
    markdown = markdown.slice(0, change.start) + change.url + markdown.slice(change.end);
  return markdown;
}
