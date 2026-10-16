/** Хеширование дедуплицируется только в памяти страницы, без browser storage. */
const HASHES = new Map<string, Promise<string | null>>();
/** Неудачные изображения не запрашиваются снова каждым новым узлом того же автора. */
const UNAVAILABLE = new Set<string>();

/**
 * Готовит официальный Gravatar URL по SHA-256 нормализованного email. Сам email не передаётся.
 * Недоступность WebCrypto оставляет локальный fallback и не блокирует граф.
 */
export const getGravatarUrl = async (email: string): Promise<string | null> => {
  const normalized = email.trim().toLowerCase();
  if (normalized === "" || globalThis.crypto?.subtle === undefined) return null;
  let pending = HASHES.get(normalized);
  if (pending === undefined) {
    pending = crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(normalized))
      .then((digest) =>
        [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      )
      .catch(() => null);
    HASHES.set(normalized, pending);
  }
  const hash = await pending;
  if (hash === null) return null;
  const url = `https://gravatar.com/avatar/${hash}?s=80&d=404&r=g`;
  return UNAVAILABLE.has(url) ? null : url;
};

/**
 * Запоминает 404/сетевой отказ изображения; это не отказ чтения истории Relay.
 */
export const markGravatarUnavailable = (url: string): void => {
  UNAVAILABLE.add(url);
};
