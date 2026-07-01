// Stale-while-revalidate cache for a portal/desk payload.
//
// Why this exists: the live backend is Google Apps Script, which cold-starts in
// 3–5s. Showing a blank "Loading…" for that long feels broken — especially for a
// home-screen app the client opens daily. So we stash the last good payload on the
// client's own device (keyed by their token) and paint it INSTANTLY on open, then
// revalidate against the server in the background. Repeat opens are instant; a
// transient backend hiccup never dead-ends because we still have the last payload.
//
// Only the client's own data is cached, namespaced by token, so nothing leaks
// across clients on a shared device. Pure + storage-injectable for tests.

// Build the cache key for a token. Returns null for a blank token so we never
// cache anonymously (and callers can cheaply skip caching).
export function dataCacheKey(prefix, token) {
  const t = (token || "").trim();
  return t ? `${prefix}.${t}` : null;
}

// Read + parse a cached payload. Returns null on miss, blocked storage, or
// malformed JSON — never throws.
export function readDataCache(storage, key) {
  if (!storage || !key) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Persist a payload. Best-effort: no-ops (returns false) on null storage/key,
// null/undefined data, or a storage exception (quota / private mode). Never
// clobbers a good cache with junk.
export function writeDataCache(storage, key, data) {
  if (!storage || !key || data == null) return false;
  try {
    storage.setItem(key, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}
