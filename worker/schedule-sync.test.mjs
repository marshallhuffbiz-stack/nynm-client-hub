import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSchedule, projectVendors, reconcile } from "./schedule-sync.mjs";

const NOW = new Date("2026-07-07T12:00:00Z");

// Vendor registry rows (as returned by the backend admin GET `vendors[]`).
const VENDORS = [
  { id: "island-boys-food-truck", clientId: "eats-on-601", name: "Island Boys Food Truck", category: "CARIBBEAN", price: "$$", tagline: "Island eats", active: true },
  { id: "bella-sweet-boutique", clientId: "eats-on-601", name: "Bella Sweet Boutique", category: "DESSERTS", price: "$$", tagline: "Sweets", active: true },
  { id: "retired-truck", clientId: "eats-on-601", name: "Retired Truck", category: "TACOS", price: "$", tagline: "gone", active: false },
];

// Bookings (as returned by the backend admin GET `bookings[]`).
const BOOKINGS = [
  { id: "b1", clientId: "eats-on-601", vendorId: "island-boys-food-truck", vendorName: "Island Boys Food Truck", date: "2026-07-11", startTime: "11:00", endTime: "19:00", note: "", seriesId: "", status: "scheduled" },
  { id: "b2", clientId: "eats-on-601", vendorId: "bella-sweet-boutique", vendorName: "Bella Sweet Boutique", date: "2026-07-11", startTime: "12:00", endTime: "17:00", note: "", seriesId: "", status: "scheduled" },
  { id: "b3", clientId: "eats-on-601", vendorId: "island-boys-food-truck", vendorName: "Island Boys Food Truck", date: "2026-07-18", startTime: "11:00", endTime: "19:00", note: "", seriesId: "", status: "scheduled" },
  { id: "b4", clientId: "eats-on-601", vendorId: "bella-sweet-boutique", vendorName: "Bella Sweet Boutique", date: "2026-07-05", startTime: "12:00", endTime: "17:00", note: "", seriesId: "", status: "cancelled" },
];

// ---- buildSchedule (pure) ----

test("buildSchedule: groups multiple trucks on one date into one day object", () => {
  const sched = buildSchedule(BOOKINGS, VENDORS, { now: NOW });
  const day = sched.find((d) => d.date === "2026-07-11");
  assert.ok(day, "day exists");
  assert.equal(day.vendors.length, 2, "both trucks on 7/11 grouped");
  assert.deepEqual(day.vendors.map((v) => v.id).sort(), ["bella-sweet-boutique", "island-boys-food-truck"]);
});

test("buildSchedule: each day object has id === date (website loader REQUIRES id)", () => {
  const sched = buildSchedule(BOOKINGS, VENDORS, { now: NOW });
  for (const d of sched) {
    assert.equal(d.id, d.date, `id must equal date for ${d.date}`);
    assert.ok(d.id, "id present and truthy");
  }
});

test("buildSchedule: ET-aware isoDate + display via shared helpers", () => {
  const sched = buildSchedule(BOOKINGS, VENDORS, { now: NOW });
  const day = sched.find((d) => d.date === "2026-07-11");
  // July → EDT (-04:00). isoDate carries the day's start wall time as an ET offset.
  assert.ok(day.isoDate.endsWith("-04:00"), `isoDate ET offset, got ${day.isoDate}`);
  assert.ok(day.isoDate.startsWith("2026-07-11T"), "isoDate on the event day");
  assert.match(day.display, /Sat · Jul 11/); // 2026-07-11 is a Saturday
});

test("buildSchedule: hours formatted from startTime/endTime like compactTime (11A–7P, 12–5P)", () => {
  const sched = buildSchedule(BOOKINGS, VENDORS, { now: NOW });
  const day = sched.find((d) => d.date === "2026-07-11");
  const island = day.vendors.find((v) => v.id === "island-boys-food-truck");
  const bella = day.vendors.find((v) => v.id === "bella-sweet-boutique");
  assert.equal(island.hours, "11A–7P");
  assert.equal(bella.hours, "12–5P");
});

test("buildSchedule: resolves vendor fields (category/price/name) from the registry", () => {
  const sched = buildSchedule(BOOKINGS, VENDORS, { now: NOW });
  const day = sched.find((d) => d.date === "2026-07-11");
  const island = day.vendors.find((v) => v.id === "island-boys-food-truck");
  assert.equal(island.name, "Island Boys Food Truck");
  assert.equal(island.category, "CARIBBEAN");
  assert.equal(island.price, "$$");
});

test("buildSchedule: only status===scheduled bookings are included", () => {
  const sched = buildSchedule(BOOKINGS, VENDORS, { now: NOW });
  // b4 is cancelled on 2026-07-05 → that date must not appear at all
  assert.ok(!sched.some((d) => d.date === "2026-07-05"), "cancelled-only date excluded");
});

test("buildSchedule: sorted ascending by date", () => {
  const sched = buildSchedule(BOOKINGS, VENDORS, { now: NOW });
  const dates = sched.map((d) => d.date);
  const sorted = [...dates].sort();
  assert.deepEqual(dates, sorted);
});

test("buildSchedule: empty input → empty array", () => {
  assert.deepEqual(buildSchedule([], [], { now: NOW }), []);
  assert.deepEqual(buildSchedule(null, null, { now: NOW }), []);
});

test("buildSchedule: falls back to booking vendorName when registry has no match", () => {
  const orphan = [{ id: "bx", clientId: "eats-on-601", vendorId: "ghost", vendorName: "Ghost Truck", date: "2026-08-01", startTime: "10:00", endTime: "14:00", status: "scheduled" }];
  const sched = buildSchedule(orphan, VENDORS, { now: NOW });
  const day = sched[0];
  assert.equal(day.vendors[0].name, "Ghost Truck");
  assert.equal(day.vendors[0].id, "ghost");
});

// ---- projectVendors (pure) ----

test("projectVendors: active vendors only, in the vendors.json shape", () => {
  const out = projectVendors(VENDORS);
  assert.equal(out.length, 2, "inactive vendor dropped");
  assert.ok(!out.some((v) => v.id === "retired-truck"));
  const v = out.find((x) => x.id === "island-boys-food-truck");
  assert.deepEqual(Object.keys(v).sort(), ["category", "id", "name", "price", "tagline"].sort());
  assert.equal(v.name, "Island Boys Food Truck");
  assert.equal(v.category, "CARIBBEAN");
});

test("projectVendors: empty/null input → empty array", () => {
  assert.deepEqual(projectVendors([]), []);
  assert.deepEqual(projectVendors(null), []);
});

// ---- reconcile (orchestration; all outward effects injected) ----

const CONFIG = {
  scheduleFile: "src/content/schedule.json",
  vendorsFile: "src/content/vendors.json",
  projectVendors: false,
};

function fakeGit(over = {}) {
  const calls = [];
  const ok = (out = "") => async () => ({ ok: true, out });
  return {
    calls,
    branch: ok("main"),
    status: ok(""),
    pull: ok(""),
    add: async () => { calls.push("add"); return { ok: true, out: "" }; },
    commit: async () => { calls.push("commit"); return { ok: true, out: "" }; },
    push: async () => { calls.push("push"); return { ok: true, out: "" }; },
    ...over,
  };
}

// io.readFile(rel) returns the current file text (or null if absent); io.apply(files)
// stages the built content and reports whether the repo content changed.
function fakeIO(current = {}, changed = true) {
  const calls = [];
  return {
    calls,
    readFile: async (rel) => (rel in current ? current[rel] : null),
    apply: async (staged) => { calls.push(staged); return { changed }; },
  };
}

function fakeLive(ok = true, reason = "not live") {
  const calls = [];
  return { url: "https://eatson601.com", calls, check: async (v) => { calls.push(v); return { ok, reason: ok ? "" : reason }; } };
}

// fetchState returns the backend admin payload with vendors[] + bookings[].
const fetchState = async () => ({ vendors: VENDORS, bookings: BOOKINGS });

test("reconcile: schedule changed → deploys via the site-apply push+verify pattern", async () => {
  const git = fakeGit();
  const io = fakeIO({}, true); // no current file → changed
  const live = fakeLive(true);
  const res = await reconcile({ fetchState, git, io, live, config: CONFIG, now: NOW });
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  assert.equal(res.verified, true);
  assert.deepEqual(git.calls, ["add", "commit", "push"]);
  assert.equal(live.calls.length, 1, "verified live");
});

test("reconcile: schedule unchanged → idempotent no-op (no commit/push/verify)", async () => {
  const built = buildSchedule(BOOKINGS, VENDORS, { now: NOW });
  const current = { "src/content/schedule.json": JSON.stringify(built, null, 2) + "\n" };
  const git = fakeGit();
  const io = fakeIO(current, false);
  const live = fakeLive(true);
  const res = await reconcile({ fetchState, git, io, live, config: CONFIG, now: NOW });
  assert.equal(res.changed, false);
  assert.deepEqual(git.calls, [], "no git ops when unchanged");
  assert.deepEqual(live.calls, [], "no live check when unchanged");
});

test("reconcile: guard tripped (not on main) → skipped, nothing deployed", async () => {
  const git = fakeGit({ branch: async () => ({ ok: true, out: "feature" }) });
  const io = fakeIO({}, true);
  const res = await reconcile({ fetchState, git, io, live: fakeLive(true), config: CONFIG, now: NOW });
  assert.equal(res.skipped, true);
  assert.match(res.reason, /not on main/);
  assert.deepEqual(git.calls, []);
});

test("reconcile: guard tripped (dirty schedule file) → skipped, never clobbers WIP", async () => {
  const git = fakeGit({ status: async () => ({ ok: true, out: " M src/content/schedule.json" }) });
  const io = fakeIO({}, true);
  const res = await reconcile({ fetchState, git, io, live: fakeLive(true), config: CONFIG, now: NOW });
  assert.equal(res.skipped, true);
  assert.match(res.reason, /uncommitted/);
  assert.deepEqual(git.calls, []);
});

test("reconcile: projectVendors OFF by default → only the schedule file is ever staged", async () => {
  const git = fakeGit();
  const io = fakeIO({}, true);
  const res = await reconcile({ fetchState, git, io, live: fakeLive(true), config: CONFIG, now: NOW });
  // io.apply was called with exactly the schedule file, never the vendors file.
  const stagedRels = io.calls.flat().map((f) => f.rel);
  assert.deepEqual(stagedRels, ["src/content/schedule.json"]);
  assert.ok(res.note && /projectVendors/i.test(res.note), "returns the projectVendors safety note");
});

test("reconcile: projectVendors ON → both schedule + vendors files staged", async () => {
  const git = fakeGit();
  const io = fakeIO({}, true);
  const cfg = { ...CONFIG, projectVendors: true };
  await reconcile({ fetchState, git, io, live: fakeLive(true), config: cfg, now: NOW });
  const stagedRels = io.calls.flat().map((f) => f.rel).sort();
  assert.deepEqual(stagedRels, ["src/content/schedule.json", "src/content/vendors.json"]);
});

test("reconcile: pushed but live never confirms → not verified, surfaced", async () => {
  const git = fakeGit();
  const io = fakeIO({}, true);
  const live = fakeLive(false, "schedule not live yet");
  const res = await reconcile({ fetchState, git, io, live, config: CONFIG, now: NOW });
  assert.equal(res.ok, false);
  assert.equal(res.verified, false);
  assert.match(res.reason, /not confirmed live/i);
});
