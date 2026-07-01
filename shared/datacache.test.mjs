import { test } from "node:test";
import assert from "node:assert/strict";
import { dataCacheKey, readDataCache, writeDataCache } from "./datacache.js";

// Minimal localStorage stand-in.
function memStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _dump: () => Object.fromEntries(map),
  };
}

// A storage that throws on every op (Safari private mode / quota).
const throwingStorage = {
  getItem() { throw new Error("blocked"); },
  setItem() { throw new Error("quota"); },
};

test("dataCacheKey namespaces by prefix + token", () => {
  assert.equal(dataCacheKey("relay.portal.data", "abc123"), "relay.portal.data.abc123");
});

test("dataCacheKey returns null for an empty/blank token (never cache anonymously)", () => {
  assert.equal(dataCacheKey("relay.portal.data", ""), null);
  assert.equal(dataCacheKey("relay.portal.data", "   "), null);
  assert.equal(dataCacheKey("relay.portal.data", null), null);
});

test("different tokens get different keys (no cross-client bleed)", () => {
  assert.notEqual(
    dataCacheKey("relay.portal.data", "tokenA"),
    dataCacheKey("relay.portal.data", "tokenB"),
  );
});

test("write then read round-trips the payload", () => {
  const s = memStorage();
  const key = dataCacheKey("relay.portal.data", "abc");
  const payload = { ok: true, client: { name: "The O" }, requests: [{ id: "r1" }] };
  assert.equal(writeDataCache(s, key, payload), true);
  assert.deepEqual(readDataCache(s, key), payload);
});

test("read returns null when nothing is cached", () => {
  const s = memStorage();
  assert.equal(readDataCache(s, "relay.portal.data.missing"), null);
});

test("read returns null (never throws) on malformed JSON", () => {
  const s = memStorage({ "relay.portal.data.abc": "{not valid json" });
  assert.equal(readDataCache(s, "relay.portal.data.abc"), null);
});

test("read/write are safe no-ops with null storage or null key", () => {
  assert.equal(readDataCache(null, "k"), null);
  assert.equal(readDataCache(memStorage(), null), null);
  assert.equal(writeDataCache(null, "k", { a: 1 }), false);
  assert.equal(writeDataCache(memStorage(), null, { a: 1 }), false);
});

test("write refuses null/undefined data (don't clobber cache with junk)", () => {
  const s = memStorage({ "relay.portal.data.abc": JSON.stringify({ ok: true }) });
  assert.equal(writeDataCache(s, "relay.portal.data.abc", null), false);
  assert.equal(writeDataCache(s, "relay.portal.data.abc", undefined), false);
  // existing good value is untouched
  assert.deepEqual(readDataCache(s, "relay.portal.data.abc"), { ok: true });
});

test("write swallows storage exceptions and reports false (best-effort)", () => {
  assert.equal(writeDataCache(throwingStorage, "k", { a: 1 }), false);
});

test("read swallows storage exceptions and returns null", () => {
  assert.equal(readDataCache(throwingStorage, "k"), null);
});
