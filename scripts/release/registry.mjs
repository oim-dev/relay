import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { versionMetadata } from "./metadata.mjs";

/**
 * Читает канал без авторизации и без изменения dist-tags.
 * @param {string} name Имя публичного npm-пакета.
 * @param {string} tag Проверяемый dist-tag.
 * @param {typeof fetch} [request] HTTP-клиент для проверки реестра.
 */
export async function taggedVersion(name, tag, request = fetch) {
  const response = await request(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
    { signal: AbortSignal.timeout(30000) },
  );
  if (response.status === 404) return null;
  assert(response.ok, `Не удалось проверить канал npm: HTTP ${response.status}`);
  const record = await response.json();
  assert.equal(record.name, name, "npm вернул другой пакет для канала");
  versionMetadata(record.version);
  return record.version;
}

/**
 * Сравнивает поддерживаемые SemVer; не позволяет старому retry откатить канал.
 * @param {string} left Первая версия.
 * @param {string} right Вторая версия.
 */
export function compareVersions(left, right) {
  versionMetadata(left);
  versionMetadata(right);
  /**
   * @param {string} value Проверенная версия.
   * @returns {[string[], string[] | null]} Основные компоненты и идентификаторы prerelease.
   */
  const parse = (value) => {
    const split = value.indexOf("-");
    return [
      value.slice(0, split < 0 ? undefined : split).split("."),
      split < 0 ? null : value.slice(split + 1).split("."),
    ];
  };
  const [a, ap] = parse(left);
  const [b, bp] = parse(right);
  /**
   * @param {string} x Первый числовой компонент версии.
   * @param {string} y Второй числовой компонент версии.
   */
  const numeric = (x, y) => (BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0);
  for (let i = 0; i < 3; i++) {
    // versionMetadata гарантирует наличие всех трёх основных компонентов.
    const result = numeric(/** @type {string} */ (a[i]), /** @type {string} */ (b[i]));
    if (result) return result;
  }
  if (!ap || !bp) return ap ? -1 : bp ? 1 : 0;
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const leftIdentifier = ap[i];
    const rightIdentifier = bp[i];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const an = /^\d+$/.test(leftIdentifier);
    const bn = /^\d+$/.test(rightIdentifier);
    return an && bn
      ? numeric(leftIdentifier, rightIdentifier)
      : an !== bn
        ? an
          ? -1
          : 1
        : leftIdentifier < rightIdentifier
          ? -1
          : 1;
  }
  return 0;
}

/**
 * Только 404 означает отсутствие версии; сетевые и серверные ошибки останавливают релиз.
 * @param {string} name Имя публичного npm-пакета.
 * @param {string} version Проверяемая версия.
 * @param {typeof fetch} [request] HTTP-клиент для проверки реестра.
 */
export async function publishedIntegrity(name, version, request = fetch) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const response = await request(url, { signal: AbortSignal.timeout(30000) });
  if (response.status === 404) return null;
  assert(response.ok, `Не удалось проверить npm: HTTP ${response.status}`);
  const record = await response.json();
  assert.equal(record.name, name, "npm вернул метаданные другого пакета");
  assert.equal(record.version, version, "npm вернул метаданные другой версии");
  assert(
    typeof record.dist?.integrity === "string",
    "В npm отсутствует integrity опубликованной версии",
  );
  return record.dist.integrity;
}

/**
 * Повторный запуск после локальной первой публикации допускается только для тех же байтов.
 * @param {Buffer} archive Проверенный npm-архив.
 * @param {string | null} published Integrity существующей версии или null при отсутствии.
 */
export function shouldPublish(archive, published) {
  if (published === null) return true;
  const actual = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  assert.equal(
    published,
    actual,
    "Версия уже опубликована с другим содержимым; увеличьте version и создайте новый тег",
  );
  return false;
}
