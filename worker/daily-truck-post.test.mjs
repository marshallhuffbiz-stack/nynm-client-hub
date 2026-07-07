import { test } from "node:test";
import assert from "node:assert/strict";
import { todayInET, selectDayBookings, buildDailyPost, runDailyPost } from "./daily-truck-post.mjs";
import { dayOfPostIso } from "./events-auto.mjs";

const CLIENT = "eats-on-601";
const TOKEN = "eats-token";

const VENDORS = [
  { id: "island-boys-food-truck", clientId: CLIENT, name: "Island Boys Food Truck", category: "CARIBBEAN", price: "$$", active: true },
  { id: "bella-sweet-boutique", clientId: CLIENT, name: "Bella Sweet Boutique", category: "DESSERTS", price: "$$", active: true },
];

const bk = (over) => ({ clientId: CLIENT, status: "scheduled", startTime: "11:00", endTime: "19:00", ...over });

// ---- todayInET (DST-aware "today" as YYYY-MM-DD; re-exported for the daily gate) ----

test("todayInET: EDT summer — a UTC instant that is still 'yesterday' in ET resolves to the ET date", () => {
  assert.equal(todayInET(new Date("2026-07-11T03:00:00Z")), "2026-07-10");
  assert.equal(todayInET(new Date("2026-07-11T16:00:00Z")), "2026-07-11");
});

test("todayInET: EST winter offset differs from EDT (DST boundary)", () => {
  assert.equal(todayInET(new Date("2026-01-15T04:00:00Z")), "2026-01-14");
  assert.equal(todayInET(new Date("2026-01-15T12:00:00Z")), "2026-01-15");
});

// ---- selectDayBookings ----

test("selectDayBookings: only today's scheduled bookings for the client", () => {
  const bookings = [
    bk({ id: "a", date: "2026-07-11", vendorId: "island-boys-food-truck" }),
    bk({ id: "b", date: "2026-07-11", vendorId: "bella-sweet-boutique" }),
    bk({ id: "c", date: "2026-07-12", vendorId: "island-boys-food-truck" }), // tomorrow
    bk({ id: "d", date: "2026-07-11", vendorId: "island-boys-food-truck", status: "cancelled" }), // not scheduled
    bk({ id: "e", date: "2026-07-11", vendorId: "x", clientId: "the-o" }), // other tenant
  ];
  const today = selectDayBookings(bookings, "2026-07-11", CLIENT);
  assert.deepEqual(today.map((b) => b.id).sort(), ["a", "b"]);
});

// ---- buildDailyPost (pure request fields) ----

test("buildDailyPost: multiple trucks — description lists trucks + hours, asks for a lineup graphic", () => {
  const today = [
    bk({ id: "a", date: "2026-07-11", vendorId: "island-boys-food-truck" }),
    bk({ id: "b", date: "2026-07-11", vendorId: "bella-sweet-boutique", startTime: "12:00", endTime: "17:00" }),
  ];
  const { title, description, comment } = buildDailyPost(today, VENDORS, { ymd: "2026-07-11" });
  assert.match(title, /Jul 11/);
  assert.match(description, /Island Boys Food Truck \(11A–7P\)/);
  assert.match(description, /Bella Sweet Boutique \(12–5P\)/);
  assert.match(description, /lineup graphic/i);
  assert.match(comment, /AUTO day-of post/);
  assert.match(comment, /morning of 2026-07-11/);
});

test("buildDailyPost: single truck — reads naturally (one truck, singular)", () => {
  const today = [bk({ id: "a", date: "2026-07-11", vendorId: "island-boys-food-truck" })];
  const { description } = buildDailyPost(today, VENDORS, { ymd: "2026-07-11" });
  assert.match(description, /Today on the lot: Island Boys Food Truck \(11A–7P\)\./);
  assert.match(description, /food truck and hours/); // singular
});

test("buildDailyPost: falls back to booking vendorName when the registry has no match", () => {
  const today = [bk({ id: "a", date: "2026-07-11", vendorId: "unregistered", vendorName: "Mystery Wagon" })];
  const { description } = buildDailyPost(today, VENDORS, { ymd: "2026-07-11" });
  assert.match(description, /Mystery Wagon/);
});

// ---- runDailyPost (idempotent state machine; submit/update injected) ----

const NOW_JUL11 = new Date("2026-07-11T16:00:00Z"); // midday ET on the 11th

// A fake backend: `all.requests` is mutated by submit/update so a re-run sees prior state.
function makeDeps(over = {}) {
  const requests = over.requests || [];
  const bookings = over.bookings || [];
  const all = { requests, bookings, vendors: VENDORS, clients: [{ clientId: CLIENT, token: TOKEN }] };
  const calls = { submit: [], update: [] };
  let seq = 1;
  return {
    all,
    calls,
    submitRequest:
      over.submitRequest ||
      (async (request, token) => {
        calls.submit.push({ request, token });
        // Server-side dedupe on clientRequestId (mirrors the real backend).
        const crid = request.clientRequestId;
        const dup = requests.find((r) => r.meta && r.meta.clientRequestId === crid);
        if (dup) return { ok: true, id: dup.id, deduped: true };
        const id = `req${seq++}`;
        requests.push({ id, clientId: CLIENT, type: request.type, title: request.title, description: request.description, stage: "submitted", meta: { clientRequestId: crid || "" } });
        return { ok: true, id };
      }),
    updateRequest:
      over.updateRequest ||
      (async (id, patch) => {
        calls.update.push({ id, patch });
        const r = requests.find((x) => x.id === id);
        if (!r) return { ok: false, status: 404, error: "not found" };
        if (patch.action === "send" && r.stage === "submitted") r.stage = "queued";
        if (patch.meta) r.meta = { ...r.meta, ...patch.meta };
        if (patch.comment != null) r.comment = patch.comment;
        return { ok: true };
      }),
    now: over.now || NOW_JUL11,
    config: over.config || {},
    clientId: CLIENT,
    clientToken: TOKEN,
    targetYmd: over.targetYmd,
  };
}

test("runDailyPost: 0 trucks today → {created:false, reason:'no-trucks'}, NOTHING created", async () => {
  const deps = makeDeps({ bookings: [bk({ id: "z", date: "2026-07-12", vendorId: "island-boys-food-truck" })] });
  const res = await runDailyPost(deps);
  assert.equal(res.created, false);
  assert.equal(res.reason, "no-trucks");
  assert.equal(deps.calls.submit.length, 0);
  assert.equal(deps.calls.update.length, 0);
  assert.equal(deps.all.requests.length, 0);
});

test("runDailyPost: create+queue — submits a `post` then sends it to queued with auto-markers", async () => {
  const deps = makeDeps({ bookings: [
    bk({ id: "a", date: "2026-07-11", vendorId: "island-boys-food-truck" }),
    bk({ id: "b", date: "2026-07-11", vendorId: "bella-sweet-boutique" }),
  ] });
  const res = await runDailyPost(deps);
  assert.equal(res.created, true);
  assert.ok(res.id);

  // submitRequest call: client action with the right shape + deterministic crid.
  assert.equal(deps.calls.submit.length, 1);
  const { request, token } = deps.calls.submit[0];
  assert.equal(request.type, "post");
  assert.deepEqual(request.attachments, []);
  assert.equal(request.clientRequestId, `${CLIENT}-daily-2026-07-11`);
  assert.equal(token, TOKEN);
  assert.ok(request.title && request.description);

  // updateRequest call: the queue+auto-markers patch.
  assert.equal(deps.calls.update.length, 1);
  const { id, patch } = deps.calls.update[0];
  assert.equal(id, res.id);
  assert.equal(patch.action, "send");
  assert.ok(patch.comment && /AUTO day-of post/.test(patch.comment));
  assert.equal(patch.meta.autoEvent.key, `${CLIENT}-daily-2026-07-11`);
  assert.equal(patch.meta.autoEvent.ymd, "2026-07-11");
  assert.equal(patch.meta.autoEvent.scheduledFor, dayOfPostIso("2026-07-11"));

  // Row landed queued.
  assert.equal(deps.all.requests[0].stage, "queued");
});

test("runDailyPost: autoApproveDaily=false (default) → meta.autoEvent.autoApprove is false", async () => {
  const deps = makeDeps({ bookings: [bk({ id: "a", date: "2026-07-11", vendorId: "island-boys-food-truck" })] });
  await runDailyPost(deps);
  assert.equal(deps.calls.update[0].patch.meta.autoEvent.autoApprove, false);
});

test("runDailyPost: autoApproveDaily=true → meta.autoEvent.autoApprove is true (auto-approve arms)", async () => {
  const deps = makeDeps({
    bookings: [bk({ id: "a", date: "2026-07-11", vendorId: "island-boys-food-truck" })],
    config: { autoApproveDaily: true },
  });
  await runDailyPost(deps);
  assert.equal(deps.calls.update[0].patch.meta.autoEvent.autoApprove, true);
});

test("runDailyPost: recovery — an existing 'submitted' row is only queued (no re-submit)", async () => {
  const crid = `${CLIENT}-daily-2026-07-11`;
  const deps = makeDeps({
    bookings: [bk({ id: "a", date: "2026-07-11", vendorId: "island-boys-food-truck" })],
    requests: [{ id: "req-partial", clientId: CLIENT, type: "post", stage: "submitted", meta: { clientRequestId: crid } }],
  });
  const res = await runDailyPost(deps);
  assert.equal(res.queued, true);
  assert.equal(res.id, "req-partial");
  assert.equal(deps.calls.submit.length, 0, "never re-submits — that would try to create a 2nd row");
  assert.equal(deps.calls.update.length, 1);
  assert.equal(deps.all.requests.find((r) => r.id === "req-partial").stage, "queued");
});

test("runDailyPost: idempotent — an existing 'ready' row is left alone (skipped)", async () => {
  const crid = `${CLIENT}-daily-2026-07-11`;
  const deps = makeDeps({
    bookings: [bk({ id: "a", date: "2026-07-11", vendorId: "island-boys-food-truck" })],
    requests: [{ id: "req-r", clientId: CLIENT, type: "post", stage: "ready", meta: { clientRequestId: crid } }],
  });
  const res = await runDailyPost(deps);
  assert.equal(res.skipped, true);
  assert.equal(res.stage, "ready");
  assert.equal(deps.calls.submit.length, 0);
  assert.equal(deps.calls.update.length, 0);
});

test("runDailyPost: idempotent — an existing 'done' row is left alone (skipped, no double-post)", async () => {
  const crid = `${CLIENT}-daily-2026-07-11`;
  const deps = makeDeps({
    bookings: [bk({ id: "a", date: "2026-07-11", vendorId: "island-boys-food-truck" })],
    requests: [{ id: "req-done", clientId: CLIENT, type: "post", stage: "done", meta: { clientRequestId: crid } }],
  });
  const res = await runDailyPost(deps);
  assert.equal(res.skipped, true);
  assert.equal(res.stage, "done");
  assert.equal(deps.calls.submit.length, 0);
  assert.equal(deps.calls.update.length, 0);
});

test("runDailyPost: a re-run after a completed create is a no-op (skipped, single row)", async () => {
  const deps = makeDeps({ bookings: [bk({ id: "a", date: "2026-07-11", vendorId: "island-boys-food-truck" })] });
  const first = await runDailyPost(deps);
  assert.equal(first.created, true);
  // Second run sees the queued row it just created → skips.
  const second = await runDailyPost(deps);
  assert.equal(second.skipped, true);
  assert.equal(second.stage, "queued");
  assert.equal(deps.all.requests.length, 1, "exactly one row across two runs");
});

test("runDailyPost: targetYmd override selects that date's trucks, keys the crid to it", async () => {
  const deps = makeDeps({
    bookings: [
      bk({ id: "a", date: "2026-07-11", vendorId: "island-boys-food-truck" }),
      bk({ id: "b", date: "2026-07-20", vendorId: "bella-sweet-boutique" }),
    ],
    now: NOW_JUL11,
    targetYmd: "2026-07-20",
  });
  const res = await runDailyPost(deps);
  assert.equal(res.created, true);
  assert.equal(res.ymd, "2026-07-20");
  assert.equal(deps.calls.submit[0].request.clientRequestId, `${CLIENT}-daily-2026-07-20`);
  assert.match(deps.calls.submit[0].request.description, /Bella Sweet Boutique/);
});

test("runDailyPost: 'today' is computed in ET (DST) — a late-UTC instant selects the correct ET day", async () => {
  // 2026-07-12T02:00:00Z is 2026-07-11 22:00 EDT → still the 11th in ET.
  const deps = makeDeps({
    bookings: [bk({ id: "a", date: "2026-07-11", vendorId: "island-boys-food-truck" })],
    now: new Date("2026-07-12T02:00:00Z"),
  });
  const res = await runDailyPost(deps);
  assert.equal(res.created, true);
  assert.equal(res.ymd, "2026-07-11", "selected the 11th's trucks, not the 12th's");
});
