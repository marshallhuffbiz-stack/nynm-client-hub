import { test } from "node:test";
import assert from "node:assert/strict";
import { cancelCrid, isCancellationRequest, cancelPostCandidates, runCancelPosts } from "./cancel-posts.mjs";
import { autoEventCandidates } from "./auto-events.mjs";

const CLIENT = "eats-on-601";
const NOW = new Date("2026-07-14T18:00:00Z");

const req = (over) => ({
  id: "req_1",
  clientId: CLIENT,
  type: "post",
  stage: "submitted",
  title: "Canceled — Island Boys Food Truck (Tue · Jul 14)",
  description: "Island Boys Food Truck has canceled for Tue · Jul 14.",
  meta: { clientRequestId: cancelCrid(CLIENT, "bkg_abc") },
  ...over,
});

const BOOKING = {
  id: "bkg_abc", clientId: CLIENT, vendorId: "island-boys-food-truck",
  vendorName: "Island Boys Food Truck", date: "2026-07-14",
  startTime: "11:00", endTime: "19:00", status: "cancelled",
};
const VENDORS = [{ id: "island-boys-food-truck", clientId: CLIENT, name: "Island Boys Food Truck", active: true }];

// ---- marker helpers ----

test("cancelCrid + isCancellationRequest: recognizes the deterministic marker, not other crids", () => {
  assert.equal(cancelCrid(CLIENT, "bkg_abc"), "eats-on-601-cancel-bkg_abc");
  assert.equal(isCancellationRequest(req()), true);
  assert.equal(isCancellationRequest(req({ meta: { clientRequestId: "eats-on-601-daily-2026-07-14" } })), false);
  assert.equal(isCancellationRequest(req({ meta: {} })), false);
  assert.equal(isCancellationRequest(null), false);
});

// ---- candidates ----

test("cancelPostCandidates: submitted cancel-marked posts for the client only; already-queued excluded", () => {
  const rs = [
    req(),                                                            // yes
    req({ id: "r2", stage: "queued" }),                               // no: already queued
    req({ id: "r3", meta: { clientRequestId: "x", autoEvent: {} } }), // no: not cancel-marked
    req({ id: "r4", clientId: "the-o" }),                             // no: other tenant
    req({ id: "r5", type: "website" }),                               // no: not a post
    req({ id: "r6", meta: { clientRequestId: cancelCrid(CLIENT, "bkg_z"), autoEvent: { checked: true } } }), // no: already processed
  ];
  assert.deepEqual(cancelPostCandidates(rs, CLIENT).map((r) => r.id), ["req_1"]);
});

// ---- auto-events must NOT grab cancellation requests (the date extractor would
// wrongly turn "canceled for Jul 14" into a website event + day-of lineup post) ----

test("autoEventCandidates excludes cancellation-marked requests", () => {
  const r = req({ title: "Canceled — Island Boys (Jul 14)", description: "Canceled for 2026-07-14" });
  assert.deepEqual(autoEventCandidates([r], CLIENT), []);
});

// ---- runCancelPosts ----

test("runCancelPosts queues the request: action send, ASAP scheduledFor, autoApprove off by default", async () => {
  const updates = [];
  const res = await runCancelPosts({
    all: { requests: [req()], bookings: [BOOKING], vendors: VENDORS },
    updateRequest: async (id, patch) => { updates.push({ id, patch }); return { ok: true }; },
    now: NOW, config: {}, clientId: CLIENT,
  });
  assert.equal(res.cancelQueued, 1);
  assert.equal(res.cancelFailed, 0);
  assert.equal(updates.length, 1);
  const { id, patch } = updates[0];
  assert.equal(id, "req_1");
  assert.equal(patch.action, "send");
  assert.match(patch.comment, /cancellation/i);
  assert.match(patch.comment, /Island Boys Food Truck/);
  const ae = patch.meta.autoEvent;
  assert.equal(ae.key, cancelCrid(CLIENT, "bkg_abc"));
  assert.equal(ae.ymd, "2026-07-14");
  assert.equal(ae.autoApprove, false);
  assert.equal(ae.kind, "cancellation");
  // ASAP: scheduledFor is the tick's clock, not a day-of morning slot.
  assert.equal(ae.scheduledFor, NOW.toISOString());
  // The original meta (clientRequestId) must ride along, not be clobbered.
  assert.equal(patch.meta.clientRequestId, cancelCrid(CLIENT, "bkg_abc"));
});

test("runCancelPosts: autoApprove follows config.autoApproveCancelPosts", async () => {
  const updates = [];
  await runCancelPosts({
    all: { requests: [req()], bookings: [BOOKING], vendors: VENDORS },
    updateRequest: async (id, patch) => { updates.push(patch); return { ok: true }; },
    now: NOW, config: { autoApproveCancelPosts: true }, clientId: CLIENT,
  });
  assert.equal(updates[0].meta.autoEvent.autoApprove, true);
});

test("runCancelPosts: booking missing from payload — still queues, comment falls back to the request title", async () => {
  const updates = [];
  const res = await runCancelPosts({
    all: { requests: [req()], bookings: [], vendors: [] },
    updateRequest: async (id, patch) => { updates.push(patch); return { ok: true }; },
    now: NOW, config: {}, clientId: CLIENT,
  });
  assert.equal(res.cancelQueued, 1);
  assert.match(updates[0].comment, /Canceled — Island Boys Food Truck/);
  assert.equal(updates[0].meta.autoEvent.ymd, "");
});

test("runCancelPosts: a failing update is counted, doesn't break the batch", async () => {
  const two = [req(), req({ id: "req_2", meta: { clientRequestId: cancelCrid(CLIENT, "bkg_def") } })];
  let calls = 0;
  const res = await runCancelPosts({
    all: { requests: two, bookings: [BOOKING], vendors: VENDORS },
    updateRequest: async () => { calls += 1; if (calls === 1) throw new Error("boom"); return { ok: true }; },
    now: NOW, config: {}, clientId: CLIENT, log: () => {},
  });
  assert.equal(res.cancelQueued, 1);
  assert.equal(res.cancelFailed, 1);
});
