import { test } from "node:test";
import assert from "node:assert/strict";
import { todayInET, selectDayBookings, buildDailyPlan, runDailyPost } from "./daily-truck-post.mjs";

const VENDORS = [
  { id: "island-boys-food-truck", clientId: "eats-on-601", name: "Island Boys Food Truck", category: "CARIBBEAN", price: "$$", tagline: "Island eats", active: true },
  { id: "bella-sweet-boutique", clientId: "eats-on-601", name: "Bella Sweet Boutique", category: "DESSERTS", price: "$$", tagline: "Sweets", active: true },
];

const bk = (over) => ({ clientId: "eats-on-601", status: "scheduled", startTime: "11:00", endTime: "19:00", ...over });

// ---- todayInET (DST-aware "today" as YYYY-MM-DD) ----

test("todayInET: EDT summer — a UTC instant that is still 'yesterday' in ET resolves to the ET date", () => {
  // 2026-07-11T03:00:00Z is 2026-07-10 23:00 EDT → ET date is the 10th, not the 11th.
  assert.equal(todayInET(new Date("2026-07-11T03:00:00Z")), "2026-07-10");
  // Same wall clock midday is unambiguously the 11th.
  assert.equal(todayInET(new Date("2026-07-11T16:00:00Z")), "2026-07-11");
});

test("todayInET: EST winter offset differs from EDT (DST boundary)", () => {
  // 2026-01-15T04:00:00Z is 2026-01-14 23:00 EST → the 14th.
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
  ];
  const today = selectDayBookings(bookings, "2026-07-11");
  assert.deepEqual(today.map((b) => b.id).sort(), ["a", "b"]);
});

// ---- buildDailyPlan (render spec + caption, DRY-RUN) ----

test("buildDailyPlan: assembles render inputs + caption for the day's lineup", () => {
  const today = [
    bk({ id: "a", date: "2026-07-11", vendorId: "island-boys-food-truck" }),
    bk({ id: "b", date: "2026-07-11", vendorId: "bella-sweet-boutique", startTime: "12:00", endTime: "17:00" }),
  ];
  const plan = buildDailyPlan(today, VENDORS, { date: "2026-07-11" });
  assert.equal(plan.render.vendors.length, 2);
  assert.equal(plan.render.vendors[0].name, "Island Boys Food Truck");
  assert.equal(plan.render.vendors[0].hours, "11A–7P");
  assert.ok(plan.render.display && /Jul 11/.test(plan.render.display));
  assert.ok(typeof plan.caption === "string" && plan.caption.length > 0);
  assert.match(plan.caption, /Island Boys Food Truck/);
});

test("buildDailyPlan: FB→IG staggered ordering represented in the plan", () => {
  const today = [bk({ id: "a", date: "2026-07-11", vendorId: "island-boys-food-truck" })];
  const plan = buildDailyPlan(today, VENDORS, { date: "2026-07-11" });
  assert.deepEqual(plan.channelsOrder, ["facebook", "instagram"], "FB first, then IG (anti-burst stagger)");
});

// ---- runDailyPost (orchestration; all outward effects injected) ----

const NOW_JUL11 = new Date("2026-07-11T16:00:00Z"); // midday ET on the 11th

function makeDeps(over = {}) {
  const calls = { publish: [], notify: [], createDraft: [] };
  return {
    calls,
    fetchState: over.fetchState || (async () => ({ vendors: VENDORS, bookings: over.bookings || [] })),
    publish: over.publish || (async (plan) => { calls.publish.push(plan); return { ok: true, postIds: ["p1", "p2"] }; }),
    createDraft: over.createDraft || (async (draft) => { calls.createDraft.push(draft); return { ok: true, id: "req1" }; }),
    notify: over.notify || (async (n) => { calls.notify.push(n); return true; }),
    now: over.now || NOW_JUL11,
    alreadyPostedFor: over.alreadyPostedFor || (async () => false),
  };
}

test("runDailyPost: 0 trucks today → {posted:false, reason:'no-trucks'} with NO side effects", async () => {
  const deps = makeDeps({ bookings: [bk({ id: "z", date: "2026-07-12", vendorId: "island-boys-food-truck" })] });
  const res = await runDailyPost(deps);
  assert.equal(res.posted, false);
  assert.equal(res.reason, "no-trucks");
  assert.equal(deps.calls.publish.length, 0);
  assert.equal(deps.calls.notify.length, 0);
  assert.equal(deps.calls.createDraft.length, 0);
});

test("runDailyPost: ≥1 truck, publish succeeds → posted:true, publish called with the plan", async () => {
  const deps = makeDeps({ bookings: [
    bk({ id: "a", date: "2026-07-11", vendorId: "island-boys-food-truck" }),
    bk({ id: "b", date: "2026-07-11", vendorId: "bella-sweet-boutique" }),
  ] });
  const res = await runDailyPost(deps);
  assert.equal(res.posted, true);
  assert.equal(deps.calls.publish.length, 1);
  const plan = deps.calls.publish[0];
  assert.equal(plan.render.vendors.length, 2);
  assert.equal(deps.calls.notify.length, 0, "no failure notify on success");
  assert.equal(deps.calls.createDraft.length, 0, "no fallback draft on success");
});

test("runDailyPost: publish throws → notify AND createDraft fallback, {posted:false, fallback:true}", async () => {
  const deps = makeDeps({
    bookings: [bk({ id: "a", date: "2026-07-11", vendorId: "island-boys-food-truck" })],
    publish: async () => { throw new Error("Postiz 429"); },
  });
  const res = await runDailyPost(deps);
  assert.equal(res.posted, false);
  assert.equal(res.fallback, true);
  assert.equal(deps.calls.notify.length, 1, "ntfy alert fired");
  assert.ok(deps.calls.notify[0].urgent, "failure push is urgent");
  assert.equal(deps.calls.createDraft.length, 1, "Desk fallback draft created");
  assert.equal(deps.calls.createDraft[0].type, "post");
  assert.match(deps.calls.createDraft[0].caption, /Island Boys Food Truck/);
});

test("runDailyPost: publish returns {ok:false} → treated as failure (notify + fallback)", async () => {
  const deps = makeDeps({
    bookings: [bk({ id: "a", date: "2026-07-11", vendorId: "island-boys-food-truck" })],
    publish: async () => ({ ok: false, error: "no channels" }),
  });
  const res = await runDailyPost(deps);
  assert.equal(res.posted, false);
  assert.equal(res.fallback, true);
  assert.equal(deps.calls.notify.length, 1);
  assert.equal(deps.calls.createDraft.length, 1);
});

test("runDailyPost: idempotency — alreadyPostedFor(today) true → skip, no double post", async () => {
  const deps = makeDeps({
    bookings: [bk({ id: "a", date: "2026-07-11", vendorId: "island-boys-food-truck" })],
    alreadyPostedFor: async (d) => d === "2026-07-11",
  });
  const res = await runDailyPost(deps);
  assert.equal(res.posted, false);
  assert.equal(res.reason, "already-posted");
  assert.equal(deps.calls.publish.length, 0, "guard prevents re-publish");
});

test("runDailyPost: today is computed in ET (DST) — a late-UTC instant selects the correct ET day", async () => {
  // 2026-07-12T02:00:00Z is 2026-07-11 22:00 EDT → still the 11th in ET.
  const deps = makeDeps({
    bookings: [bk({ id: "a", date: "2026-07-11", vendorId: "island-boys-food-truck" })],
    now: new Date("2026-07-12T02:00:00Z"),
  });
  const res = await runDailyPost(deps);
  assert.equal(res.posted, true, "selected the 11th's trucks, not the 12th's");
});
