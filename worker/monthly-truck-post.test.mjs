import { test } from "node:test";
import assert from "node:assert/strict";
import { bookingsForMonth, buildMonthlyDraft, runMonthly } from "./monthly-truck-post.mjs";

const NOW = new Date("2026-07-25T16:00:00Z");

const bk = (over) => ({ clientId: "eats-on-601", status: "scheduled", startTime: "11:00", endTime: "19:00", vendorName: "Island Boys Food Truck", ...over });

const BOOKINGS = [
  bk({ id: "a", date: "2026-07-04", vendorName: "Island Boys Food Truck" }),
  bk({ id: "b", date: "2026-07-18", vendorName: "Bella Sweet Boutique" }),
  bk({ id: "c", date: "2026-07-31", vendorName: "Taco Cartel" }),
  bk({ id: "d", date: "2026-08-01", vendorName: "August Truck" }), // next month
  bk({ id: "e", date: "2026-07-11", vendorName: "Cancelled Co", status: "cancelled" }), // not scheduled
  bk({ id: "f", date: "2026-06-30", vendorName: "June Truck" }), // last month
];

// ---- bookingsForMonth ----

test("bookingsForMonth: selects only that YYYY-MM's scheduled bookings", () => {
  const july = bookingsForMonth(BOOKINGS, "2026-07");
  assert.deepEqual(july.map((b) => b.id).sort(), ["a", "b", "c"]);
});

test("bookingsForMonth: empty/null input → empty array", () => {
  assert.deepEqual(bookingsForMonth([], "2026-07"), []);
  assert.deepEqual(bookingsForMonth(null, "2026-07"), []);
});

// ---- buildMonthlyDraft (render inputs + caption) ----

test("buildMonthlyDraft: calendar render inputs + caption for the month", () => {
  const draft = buildMonthlyDraft(BOOKINGS, { month: "2026-07", now: NOW });
  assert.equal(draft.render.month, "2026-07");
  assert.ok(/July/i.test(draft.render.monthLabel), "human month label");
  // one entry per scheduled day this month, sorted ascending
  assert.deepEqual(draft.render.days.map((d) => d.date), ["2026-07-04", "2026-07-18", "2026-07-31"]);
  assert.ok(typeof draft.caption === "string" && draft.caption.length > 0);
  assert.match(draft.caption, /July/i);
});

test("buildMonthlyDraft: groups multiple trucks per day into one calendar cell", () => {
  const twoOnADay = [
    bk({ id: "x", date: "2026-09-05", vendorName: "Truck A" }),
    bk({ id: "y", date: "2026-09-05", vendorName: "Truck B" }),
  ];
  const draft = buildMonthlyDraft(twoOnADay, { month: "2026-09", now: NOW });
  assert.equal(draft.render.days.length, 1);
  assert.equal(draft.render.days[0].vendors.length, 2);
});

test("buildMonthlyDraft: empty month → empty days, still returns a caption", () => {
  const draft = buildMonthlyDraft(BOOKINGS, { month: "2026-12", now: NOW });
  assert.deepEqual(draft.render.days, []);
  assert.ok(typeof draft.caption === "string");
});

// ---- runMonthly (orchestration; createDraft injected) ----

test("runMonthly: creates a `post` request draft via the injected createDraft seam", async () => {
  const calls = [];
  const fetchState = async () => ({ vendors: [], bookings: BOOKINGS });
  const createDraft = async (draft) => { calls.push(draft); return { ok: true, id: "req9" }; };
  const res = await runMonthly({ fetchState, createDraft, now: NOW, month: "2026-07" });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1, "exactly one draft created");
  assert.equal(calls[0].type, "post");
  assert.ok(calls[0].render, "carries the render inputs");
  assert.match(calls[0].caption, /July/i);
  assert.equal(calls[0].render.days.length, 3);
});

test("runMonthly: defaults month to next month from now when month omitted", async () => {
  const calls = [];
  const fetchState = async () => ({ vendors: [], bookings: BOOKINGS });
  const createDraft = async (draft) => { calls.push(draft); return { ok: true, id: "r" }; };
  // now = July 25 → default target month = August (next month).
  await runMonthly({ fetchState, createDraft, now: NOW });
  assert.equal(calls[0].render.month, "2026-08");
  assert.equal(calls[0].render.days.length, 1, "the one August booking");
});

test("runMonthly: no bookings that month → still creates a draft (empty calendar), reported", async () => {
  const calls = [];
  const fetchState = async () => ({ vendors: [], bookings: BOOKINGS });
  const createDraft = async (draft) => { calls.push(draft); return { ok: true, id: "r" }; };
  const res = await runMonthly({ fetchState, createDraft, now: NOW, month: "2026-12" });
  assert.equal(res.ok, true);
  assert.equal(calls[0].render.days.length, 0);
});
