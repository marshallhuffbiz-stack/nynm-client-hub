import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveAccess,
  persistAccess,
  tokenStartUrl,
  scopeFromHref,
} from "./token.js";

// A minimal localStorage stand-in for tests.
function memStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _dump: () => Object.fromEntries(map),
  };
}

// A storage that throws on every access (Safari private mode / blocked storage).
const throwingStorage = {
  getItem: () => { throw new Error("blocked"); },
  setItem: () => { throw new Error("blocked"); },
  removeItem: () => { throw new Error("blocked"); },
};

const KEY = "relay.portal.token";

test("resolveAccess: prefers the token in the URL query", () => {
  const storage = memStorage({ [KEY]: "from-storage" });
  const r = resolveAccess({ search: "?c=from-url", storage, param: "c", tokenKey: KEY });
  assert.equal(r.token, "from-url");
  assert.equal(r.source, "url");
});

// THE BUG: an installed home-screen app launches start_url with no ?c=,
// so the token must be recovered from durable storage instead of dead-ending.
test("resolveAccess: recovers the token from storage when the URL has none", () => {
  const storage = memStorage({ [KEY]: "abc123" });
  const r = resolveAccess({ search: "", storage, param: "c", tokenKey: KEY });
  assert.equal(r.token, "abc123");
  assert.equal(r.source, "storage");
});

test("resolveAccess: source 'none' when neither URL nor storage has a token", () => {
  const storage = memStorage();
  const r = resolveAccess({ search: "", storage, param: "c", tokenKey: KEY });
  assert.equal(r.token, "");
  assert.equal(r.source, "none");
});

test("resolveAccess: also reads the pin from the URL", () => {
  const r = resolveAccess({ search: "?c=t&pin=1234", storage: memStorage(), param: "c", tokenKey: KEY });
  assert.equal(r.token, "t");
  assert.equal(r.pin, "1234");
});

test("resolveAccess: blocked storage never throws, falls back to none", () => {
  const r = resolveAccess({ search: "", storage: throwingStorage, param: "c", tokenKey: KEY });
  assert.equal(r.token, "");
  assert.equal(r.source, "none");
});

test("persistAccess: writes a verified token into storage", () => {
  const storage = memStorage();
  persistAccess(storage, { token: "abc123", tokenKey: KEY });
  assert.equal(storage.getItem(KEY), "abc123");
});

test("persistAccess: no-ops on empty token or blocked storage", () => {
  const storage = memStorage({ [KEY]: "keep" });
  persistAccess(storage, { token: "", tokenKey: KEY });
  assert.equal(storage.getItem(KEY), "keep", "empty token must not clobber a stored one");
  // must not throw on blocked storage
  persistAccess(throwingStorage, { token: "x", tokenKey: KEY });
});

test("tokenStartUrl: forces the token param onto the launch URL", () => {
  const url = tokenStartUrl("https://x.github.io/nynm-client-hub/portal/", "c", "abc123");
  assert.equal(url, "https://x.github.io/nynm-client-hub/portal/?c=abc123");
});

test("tokenStartUrl: overrides any stale token already in the href and drops the hash", () => {
  const url = tokenStartUrl("https://x.github.io/portal/?c=old&pin=9#frag", "c", "new");
  const u = new URL(url);
  assert.equal(u.searchParams.get("c"), "new");
  assert.equal(u.hash, "");
});

test("scopeFromHref: returns the directory of the current document", () => {
  assert.equal(
    scopeFromHref("https://x.github.io/nynm-client-hub/portal/index.html?c=abc"),
    "https://x.github.io/nynm-client-hub/portal/",
  );
  assert.equal(
    scopeFromHref("https://x.github.io/nynm-client-hub/portal/"),
    "https://x.github.io/nynm-client-hub/portal/",
  );
});
