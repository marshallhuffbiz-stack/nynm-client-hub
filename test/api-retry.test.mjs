/**
 * api-retry.test.mjs — pins the transient-retry behaviour added to shared/api.js so a
 * flaky mobile connection (or the 30s script-lock "busy, try again" 409) no longer
 * surfaces to the client as a dead-end "That didn't send". Stubs global.fetch; the
 * client's compressImage path is untouched because submit sends JSON, not a File.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { portalApi } from "../shared/api.js";

// Run fn with a stubbed global.fetch, always restoring the original afterward.
function withFetch(fn) {
  return async () => {
    const orig = global.fetch;
    try {
      await fn();
    } finally {
      global.fetch = orig;
    }
  };
}
const jsonRes = (obj) => ({ json: async () => obj });

test("submit retries a transient 409 (busy lock) and then succeeds", withFetch(async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return calls === 1
      ? jsonRes({ ok: false, status: 409, error: "busy, try again" })
      : jsonRes({ ok: true, status: 200, id: "req_1" });
  };
  const res = await portalApi("tok").submit({ type: "post", description: "hi" }, "cli_1");
  assert.equal(res.ok, true);
  assert.equal(res.id, "req_1");
  assert.equal(calls, 2); // one retry
}));

test("submit retries a dropped connection (fetch throws) before giving up", withFetch(async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls < 2) throw new Error("Failed to fetch");
    return jsonRes({ ok: true, status: 200, id: "req_2" });
  };
  const res = await portalApi("tok").submit({ type: "post", description: "hi" }, "cli_2");
  assert.equal(res.ok, true);
  assert.equal(calls, 2);
}));

test("submit gives up (throws) after exhausting its retries on a persistent outage", withFetch(async () => {
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error("Failed to fetch"); };
  await assert.rejects(() => portalApi("tok").submit({ type: "post", description: "hi" }, "cli_3"));
  assert.equal(calls, 3); // initial attempt + 2 retries
}));

test("a plain GET (load) has no retry budget — one shot, surfaces the status", withFetch(async () => {
  let calls = 0;
  global.fetch = async () => { calls += 1; return jsonRes({ ok: false, status: 500, error: "boom" }); };
  const res = await portalApi("tok").load();
  assert.equal(res.status, 500);
  assert.equal(calls, 1); // no retry on a non-opted-in call
}));
