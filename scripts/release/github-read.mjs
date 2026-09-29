import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";

export const evidenceLimit = 32 * 1024;
const archiveLimit = 1024 * 1024;

async function boundedBody(response, limit) {
  assert(response.body, "GitHub вернул пустой ответ");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert(size <= limit, "Ответ GitHub превышает допустимый размер");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Только чтение. Токен не отправляется на URL хранилища артефактов и не попадает в ошибки. */
export function githubReader(token, fetcher = fetch) {
  assert(token, "Для проверки происхождения нужен GitHub token с правами чтения");
  async function request(path, archive = false) {
    assert(path.startsWith("/repos/") && !path.includes(".."));
    const options = {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    };
    try {
      let response = await fetcher(`https://api.github.com${path}`, options);
      if (archive && response.status === 302) {
        const url = new URL(response.headers.get("location"));
        await response.body?.cancel();
        assert(
          url.protocol === "https:" && !url.username && !url.password,
          "Небезопасный адрес артефакта",
        );
        response = await fetcher(url.href, {
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        });
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error(`GitHub HTTP ${response.status}`);
      }
      return await boundedBody(response, archive ? archiveLimit : 8 * 1024 * 1024);
    } catch {
      // Даже сообщение сетевой ошибки может содержать signed URL или заголовки.
      throw new Error("Не удалось безопасно прочитать GitHub API/артефакт; выпуск закрыт");
    }
  }
  return {
    async json(path) {
      try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await request(path)));
      } catch {
        throw new Error("Ошибка GitHub HTTP/JSON; выпуск закрыт");
      }
    },
    archive: (path) => request(path, true),
  };
}

export async function allPages(client, path, field) {
  const result = [];
  for (let page = 1; page <= 100; page++) {
    const response = await client.json(
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    const entries = field ? response[field] : response;
    assert(Array.isArray(entries), "Неверный список GitHub API");
    result.push(...entries);
    if (entries.length < 100) {
      if (field) assert.equal(response.total_count, result.length, "Неполный список GitHub API");
      return result;
    }
  }
  throw new Error("Список GitHub API не прочитан полностью; выпуск закрыт");
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Принимается только малый обычный ZIP с единственным verification.json, без записи на диск. */
export function readEvidenceZip(zip) {
  assert(Buffer.isBuffer(zip) && zip.length >= 22 && zip.length <= archiveLimit, "Неверный ZIP");
  const end = zip.length - 22;
  assert.equal(
    zip.readUInt32LE(end),
    0x06054b50,
    "Нет ZIP EOCD (ZIP64/комментарии не поддерживаются)",
  );
  assert.equal(zip.readUInt32LE(end + 4), 0, "Многотомный ZIP запрещён");
  assert.equal(zip.readUInt16LE(end + 8), 1);
  assert.equal(zip.readUInt16LE(end + 10), 1, "В свидетельстве должен быть ровно один файл");
  assert.equal(zip.readUInt16LE(end + 20), 0);
  const centralSize = zip.readUInt32LE(end + 12);
  const central = zip.readUInt32LE(end + 16);
  assert(
    central + centralSize === end && centralSize >= 46 && central >= 30,
    "Повреждён каталог ZIP",
  );
  assert.equal(zip.readUInt32LE(central), 0x02014b50);
  const flags = zip.readUInt16LE(central + 8);
  const method = zip.readUInt16LE(central + 10);
  assert((flags & ~0x0808) === 0 && [0, 8].includes(method), "Неподдерживаемый ZIP");
  const crc = zip.readUInt32LE(central + 16);
  const compressedSize = zip.readUInt32LE(central + 20);
  const size = zip.readUInt32LE(central + 24);
  const nameLength = zip.readUInt16LE(central + 28);
  const extraLength = zip.readUInt16LE(central + 30);
  const commentLength = zip.readUInt16LE(central + 32);
  assert(size > 0 && size <= evidenceLimit, "Слишком большое свидетельство");
  assert.equal(46 + nameLength + extraLength + commentLength, centralSize);
  assert.equal(
    zip.subarray(central + 46, central + 46 + nameLength).toString("utf8"),
    "verification.json",
  );
  assert.equal(zip.readUInt16LE(central + 34), 0);
  assert.equal(zip.readUInt32LE(central + 42), 0, "Лишний префикс ZIP");
  const unixMode = zip.readUInt32LE(central + 38) >>> 16;
  assert([0, 0o100000].includes(unixMode & 0o170000), "Симлинк/каталог вместо свидетельства");
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt16LE(6), flags);
  assert.equal(zip.readUInt16LE(8), method);
  assert.equal(zip.readUInt16LE(26), nameLength);
  assert.equal(zip.subarray(30, 30 + nameLength).toString("utf8"), "verification.json");
  const start = 30 + nameLength + zip.readUInt16LE(28);
  const stop = start + compressedSize;
  assert(start <= stop && stop <= central);
  if (flags & 8) {
    const descriptor = stop + (central - stop === 16 ? 4 : 0);
    if (descriptor !== stop) assert.equal(zip.readUInt32LE(stop), 0x08074b50);
    assert.equal(central - descriptor, 12);
    assert.equal(zip.readUInt32LE(descriptor), crc);
    assert.equal(zip.readUInt32LE(descriptor + 4), compressedSize);
    assert.equal(zip.readUInt32LE(descriptor + 8), size);
  } else {
    assert.equal(stop, central);
    assert.equal(zip.readUInt32LE(14), crc);
    assert.equal(zip.readUInt32LE(18), compressedSize);
    assert.equal(zip.readUInt32LE(22), size);
  }
  const bytes =
    method === 0
      ? zip.subarray(start, stop)
      : inflateRawSync(zip.subarray(start, stop), { maxOutputLength: evidenceLimit });
  assert.equal(bytes.length, size);
  assert.equal(crc32(bytes), crc, "CRC свидетельства не совпадает");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
