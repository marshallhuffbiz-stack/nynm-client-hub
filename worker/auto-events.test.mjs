import { test } from "node:test";
import assert from "node:assert/strict";
import { autoEventCandidates, processAutoEvents, autoApproveReadyCandidates, autoApproveReady } from "./auto-events.mjs";

const NOW = new Date("2026-06-22T12:00:00Z");
const CLIENT = "eats-on-601";

function fakeApi() {
  const patches = [];
  return { patches, apiUpdate: async (b, t, id, patch) => { patches.push({ id, patch }); return { ok: true }; } };
}

test("autoEventCandidates: only fresh, dated, right-client requests", () => {
  const reqs = [
    { id: "a", clientId: CLIENT, stage: "submitted", type: "post", title: "AP Southern Kitchen Saturday June 28" },
    { id: "b", clientId: CLIENT, stage: "submitted", type: "post", title: "make the logo bigger" }, // no date
    { id: "c", clientId: "the-o", stage: "submitted", type: "post", title: "event June 28" }, // other client
    { id: "d", clientId: CLIENT, stage: "ready", type: "post", title: "thing June 28" }, // not fresh
    { id: "e", clientId: CLIENT, stage: "submitted", type: "post", title: "x June 28", meta: { autoEvent: { checked: true } } }, // already handled
  ];
  assert.deepEqual(autoEventCandidates(reqs, CLIENT).map((r) => r.id), ["a"]);
});

test("processAutoEvents: confident → site push + auto-queue + meta flag + notify", async () => {
  const api = fakeApi();
  const notes = [];
  const reqs = [{ id: "a", clientId: CLIENT, stage: "submitted", type: "post", title: "AP Southern Kitchen Saturday June 28 11-4", meta: { thread: [1] } }];
  const res = await processAutoEvents({
    apiBase: "b", adminToken: "A", requests: reqs, autoClientId: CLIENT,
    extract: async () => ({ hasDate: true, confident: true, title: "AP Southern Kitchen", ymd: "2026-06-28", timeStart: "11 AM", timeEnd: "4 PM", kind: "vendor-day", description: "Southern food" }),
    syncSite: async () => ({ ok: true, changed: true }),
    apiUpdate: api.apiUpdate,
    notifier: { notifyAutoEvent: async (x) => notes.push(x) },
    now: () => NOW,
  });
  assert.deepEqual(res.queuedIds, ["a"]);
  assert.equal(res.queued, 1);
  const p = api.patches[0].patch;
  assert.equal(p.action, "send"); // auto-queued
  assert.equal(p.meta.autoEvent.autoApprove, true);
  assert.equal(p.meta.autoEvent.ymd, "2026-06-28");
  assert.equal(p.meta.autoEvent.scheduledFor, "2026-06-28T08:00:00-04:00");
  assert.deepEqual(p.meta.thread, [1]); // existing meta preserved
  assert.match(p.comment, /day-of/i);
  assert.equal(notes.length, 1);
});

test("processAutoEvents: not confident → marked checked, NOT queued (falls back to manual)", async () => {
  const api = fakeApi();
  const reqs = [{ id: "a", clientId: CLIENT, stage: "submitted", type: "post", title: "something this weekend maybe" }];
  const res = await processAutoEvents({
    apiBase: "b", adminToken: "A", requests: reqs, autoClientId: CLIENT,
    extract: async () => ({ hasDate: false, confident: false }),
    syncSite: async () => ({ ok: true }),
    apiUpdate: api.apiUpdate,
    notifier: {},
    now: () => NOW,
  });
  assert.equal(res.queued, 0);
  assert.equal(res.skipped, 1);
  assert.equal(api.patches[0].patch.meta.autoEvent.checked, true);
  assert.equal(api.patches[0].patch.meta.autoEvent.confident, false);
  assert.equal(api.patches[0].patch.action, undefined); // not queued
});

test("processAutoEvents: transient extraction error → request left untouched (retries later)", async () => {
  const api = fakeApi();
  const reqs = [{ id: "a", clientId: CLIENT, stage: "submitted", type: "post", title: "AP Southern Kitchen June 28" }];
  const res = await processAutoEvents({
    apiBase: "b", adminToken: "A", requests: reqs, autoClientId: CLIENT,
    extract: async () => ({ hasDate: false, confident: false, error: true }),
    syncSite: async () => ({ ok: true }),
    apiUpdate: api.apiUpdate,
    notifier: {},
    now: () => NOW,
  });
  assert.equal(res.errored, 1);
  assert.equal(res.queued, 0);
  assert.equal(res.skipped, 0);
  assert.equal(api.patches.length, 0); // never touched the request
});

test("autoApproveReadyCandidates: ready + autoApprove + not yet approved", () => {
  const reqs = [
    { id: "a", stage: "ready", meta: { autoEvent: { autoApprove: true } } },
    { id: "b", stage: "ready", meta: { autoEvent: { autoApprove: true, approved: true } } }, // already approved
    { id: "c", stage: "ready", meta: {} }, // not an auto-event
    { id: "d", stage: "approved", meta: { autoEvent: { autoApprove: true } } }, // not ready
  ];
  assert.deepEqual(autoApproveReadyCandidates(reqs).map((r) => r.id), ["a"]);
});

test("autoApproveReady: sets draft.scheduledFor + approves + marks approved", async () => {
  const api = fakeApi();
  const reqs = [{ id: "a", stage: "ready", draft: { caption: "hi" }, meta: { autoEvent: { autoApprove: true, scheduledFor: "2026-06-28T08:00:00-04:00" } } }];
  const res = await autoApproveReady({ apiBase: "b", adminToken: "A", requests: reqs, apiUpdate: api.apiUpdate, now: () => NOW });
  assert.equal(res.approved, 1);
  const p = api.patches[0].patch;
  assert.equal(p.action, "approve");
  assert.equal(p.draft.scheduledFor, "2026-06-28T08:00:00-04:00");
  assert.equal(p.draft.caption, "hi"); // existing draft preserved
  assert.equal(p.meta.autoEvent.approved, true);
});
