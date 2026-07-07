import { test } from "node:test";
import assert from "node:assert/strict";
import { bookingsForMonth, buildMonthlyPost, monthOf, runMonthly } from "./monthly-truck-post.mjs";

const CLIENT = "eats-on-601";
const TOKEN = "eats-token";
const NOW = new Date("2026-07-25T16:00:00Z");

const bk = (over) => ({ clientId: CLIENT, status: "scheduled", startTime: "11:00", endTime: "19:00", vendorName: "Island Boys Food Truck", ...over });

const BOOKINGS = [
  bk({ id: "a", date: "2026-07-04", vendorName: "Island Boys Food Truck" }),
  bk({ id: "b", date: "2026-07-18", vendorName: "Bella Sweet Boutique" }),
  bk({ id: "c", date: "2026-07-31", vendorName: "Taco Cartel" }),
  bk({ id: "d", date: "2026-08-01", vendorName: "August Truck" }), // next month
  bk({ id: "e", date: "2026-07-11", vendorName: "Cancelled Co", status: "cancelled" }), // not scheduled
  bk({ id: "f", date: "2026-06-30", vendorName: "June Truck" }), // last month
  bk({ id: "g", date: "2026-07-04", vendorName: "Other Tenant Truck", clientId: "the-o" }), // other tenant
];

// ---- bookingsForMonth ----

test("bookingsForMonth: selects only that YYYY-MM's scheduled bookings for the client", () => {
  const july = bookingsForMonth(BOOKINGS, "2026-07", CLIENT);
  assert.deepEqual(july.map((b) => b.id).sort(), ["a", "b", "c"]);
});

test("bookingsForMonth: empty/null input → empty array", () => {
  assert.deepEqual(bookingsForMonth([], "2026-07", CLIENT), []);
  assert.deepEqual(bookingsForMonth(null, "2026-07", CLIENT), []);
});

// ---- buildMonthlyPost (pure request fields) ----

test("buildMonthlyPost: description lays out the month's schedule, asks for a calendar graphic", () => {
  const { title, description, comment, dayCount } = buildMonthlyPost(BOOKINGS, [], { month: "2026-07", clientId: CLIENT, now: NOW });
  assert.match(title, /July 2026/);
  assert.equal(dayCount, 3);
  assert.match(description, /month-at-a-glance schedule graphic/i);
  assert.match(description, /Jul 4/);
  assert.match(description, /Bella Sweet Boutique/);
  assert.match(description, /Taco Cartel/);
  assert.match(comment, /Marshall approves this before it ships/);
});

test("buildMonthlyPost: groups multiple trucks on the same day into one schedule line", () => {
  const twoOnADay = [
    bk({ id: "x", date: "2026-09-05", vendorName: "Truck A" }),
    bk({ id: "y", date: "2026-09-05", vendorName: "Truck B" }),
  ];
  const { description, dayCount } = buildMonthlyPost(twoOnADay, [], { month: "2026-09", clientId: CLIENT, now: NOW });
  assert.equal(dayCount, 1, "one calendar day");
  assert.match(description, /Truck A.*Truck B/);
});

test("buildMonthlyPost: empty month → a 'coming soon' brief, still valid fields", () => {
  const { description, dayCount } = buildMonthlyPost(BOOKINGS, [], { month: "2026-12", clientId: CLIENT, now: NOW });
  assert.equal(dayCount, 0);
  assert.match(description, /coming soon/i);
});

// ---- monthOf ----

test("monthOf: the YYYY-MM of now", () => {
  assert.equal(monthOf(new Date("2026-07-25T16:00:00Z")), "2026-07");
  assert.equal(monthOf(new Date("2026-12-01T00:00:00Z")), "2026-12");
});

// ---- runMonthly (idempotent state machine; submit/update injected) ----

function makeDeps(over = {}) {
  const requests = over.requests || [];
  const bookings = over.bookings || BOOKINGS;
  const all = { requests, bookings, vendors: over.vendors || [], clients: [{ clientId: CLIENT, token: TOKEN }] };
  const calls = { submit: [], update: [] };
  let seq = 1;
  return {
    all,
    calls,
    submitRequest:
      over.submitRequest ||
      (async (request, token) => {
        calls.submit.push({ request, token });
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
        return { ok: true };
      }),
    now: over.now || NOW,
    clientId: CLIENT,
    clientToken: TOKEN,
    targetMonth: over.targetMonth,
  };
}

test("runMonthly: create+queue — a `post` for the month, keyed <clientId>-monthly-<yyyymm>", async () => {
  const deps = makeDeps({ targetMonth: "2026-07" });
  const res = await runMonthly(deps);
  assert.equal(res.created, true);
  assert.equal(res.month, "2026-07");
  assert.equal(deps.calls.submit.length, 1);
  assert.equal(deps.calls.submit[0].request.type, "post");
  assert.deepEqual(deps.calls.submit[0].request.attachments, []);
  assert.equal(deps.calls.submit[0].request.clientRequestId, `${CLIENT}-monthly-202607`);
  assert.equal(deps.calls.submit[0].token, TOKEN);
  assert.equal(deps.calls.update.length, 1);
  assert.equal(deps.calls.update[0].patch.action, "send");
  assert.equal(deps.all.requests[0].stage, "queued");
});

test("runMonthly: autoApprove is ALWAYS false — monthly is always Marshall-approved", async () => {
  const deps = makeDeps({ targetMonth: "2026-07" });
  await runMonthly(deps);
  assert.equal(deps.calls.update[0].patch.meta.autoEvent.autoApprove, false);
});

test("runMonthly: defaults the month to monthOf(now) when targetMonth omitted", async () => {
  const deps = makeDeps(); // now = July 25
  const res = await runMonthly(deps);
  assert.equal(res.month, "2026-07");
  assert.equal(deps.calls.submit[0].request.clientRequestId, `${CLIENT}-monthly-202607`);
});

test("runMonthly: recovery — an existing 'submitted' row is only queued (no re-submit)", async () => {
  const crid = `${CLIENT}-monthly-202607`;
  const deps = makeDeps({
    targetMonth: "2026-07",
    requests: [{ id: "m-partial", clientId: CLIENT, type: "post", stage: "submitted", meta: { clientRequestId: crid } }],
  });
  const res = await runMonthly(deps);
  assert.equal(res.queued, true);
  assert.equal(res.id, "m-partial");
  assert.equal(deps.calls.submit.length, 0);
  assert.equal(deps.calls.update.length, 1);
});

test("runMonthly: idempotent — an existing 'ready'/'done' row is left alone (skipped)", async () => {
  const crid = `${CLIENT}-monthly-202607`;
  const deps = makeDeps({
    targetMonth: "2026-07",
    requests: [{ id: "m-ready", clientId: CLIENT, type: "post", stage: "ready", meta: { clientRequestId: crid } }],
  });
  const res = await runMonthly(deps);
  assert.equal(res.skipped, true);
  assert.equal(res.stage, "ready");
  assert.equal(deps.calls.submit.length, 0);
  assert.equal(deps.calls.update.length, 0);
});

test("runMonthly: no bookings that month → still creates a 'coming soon' post (idempotent)", async () => {
  const deps = makeDeps({ targetMonth: "2026-12" });
  const res = await runMonthly(deps);
  assert.equal(res.created, true);
  assert.match(deps.calls.submit[0].request.description, /coming soon/i);
});
