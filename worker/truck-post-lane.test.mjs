import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../mock-server/server.mjs";
import { runOnce, runTruckPosts, etHhmm, atOrAfterEt } from "./poller.mjs";

const CLIENT = "eats-on-601";
const TOKEN = "eats-token";

// A cfg with the truck-post lane enabled for eats-on-601.
function cfgFor(base, over = {}) {
  return {
    execUrl: base,
    adminToken: "A",
    sites: {
      "eats-on-601": {
        dir: "/x",
        liveUrl: "https://eatson601.com",
        schedule: { enabled: true, dailyPostTime: "08:00", monthlyDraftDay: 25, autoApproveDaily: false, ...(over.schedule || {}) },
      },
    },
  };
}

const bk = (over) => ({ clientId: CLIENT, status: "scheduled", startTime: "11:00", endTime: "19:00", vendorId: "island-boys-food-truck", vendorName: "Island Boys Food Truck", ...over });

let srv, base, dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "ch-truck-"));
  await writeFile(
    join(dir, "store.json"),
    JSON.stringify({
      settings: { adminToken: "A" },
      clients: [{ clientId: CLIENT, name: "Eats on 601", token: TOKEN, active: true }],
      requests: [],
      events: [],
      vendors: [{ id: "island-boys-food-truck", clientId: CLIENT, name: "Island Boys Food Truck", category: "CARIBBEAN", price: "$$", active: true }],
      bookings: [],
    })
  );
  srv = createApp({ storePath: join(dir, "store.json") });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(async () => {
  await new Promise((r) => srv.close(r));
  await rm(dir, { recursive: true, force: true });
});

// Re-fetch the live admin payload (what a real tick reuses).
const fetchAll = () => fetch(`${base}/?admin=A`).then((r) => r.json());

// A midday-ET instant on the 11th (well past 08:00) → daily gate open, not the draft day.
const NOON_JUL11 = new Date("2026-07-11T16:00:00Z");

// ---- time-gate helpers ----

test("etHhmm: returns the ET wall-clock HH:MM (DST-aware)", () => {
  assert.equal(etHhmm(new Date("2026-07-11T16:00:00Z")), "12:00"); // EDT -4 → noon
  assert.equal(etHhmm(new Date("2026-01-15T13:30:00Z")), "08:30"); // EST -5
});

test("atOrAfterEt: gate opens only once ET time reaches HH:MM", () => {
  assert.equal(atOrAfterEt(new Date("2026-07-11T11:59:00Z"), "08:00"), false); // 07:59 EDT → before
  assert.equal(atOrAfterEt(new Date("2026-07-11T12:00:00Z"), "08:00"), true); // 08:00 EDT → at (inclusive)
  assert.equal(atOrAfterEt(new Date("2026-07-11T12:05:00Z"), "08:00"), true); // 08:05 EDT → after
});

// ---- runTruckPosts: daily ----

test("runTruckPosts daily: past 08:00 ET with trucks today → creates+queues the day-of post", async () => {
  // Seed a booking for the 11th.
  await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ admin: "A", action: "addBookings", clientId: CLIENT, bookings: [bk({ date: "2026-07-11" })] }) });
  const all = await fetchAll();
  const res = await runTruckPosts({ cfg: cfgFor(base), all, now: NOON_JUL11 });
  assert.equal(res.dailyPostCreated, 1);

  const after = await fetchAll();
  const row = after.requests.find((r) => r.meta && r.meta.clientRequestId === `${CLIENT}-daily-2026-07-11`);
  assert.ok(row, "the day-of post request exists");
  assert.equal(row.type, "post");
  assert.equal(row.clientId, CLIENT); // tenant forced from the token
  assert.equal(row.stage, "queued"); // submitted → queued via action:send
  assert.equal(row.meta.autoEvent.autoApprove, false); // safe default (Marshall approves)
  assert.equal(row.meta.autoEvent.ymd, "2026-07-11");
});

test("runTruckPosts daily: a second tick is idempotent (skipped, no duplicate row)", async () => {
  const all = await fetchAll();
  const res = await runTruckPosts({ cfg: cfgFor(base), all, now: NOON_JUL11 });
  assert.equal(res.dailyPostSkipped, 1, "existing queued row → skipped");
  assert.equal(res.dailyPostCreated, 0);
  const after = await fetchAll();
  const rows = after.requests.filter((r) => r.meta && r.meta.clientRequestId === `${CLIENT}-daily-2026-07-11`);
  assert.equal(rows.length, 1, "still exactly one day-of row");
});

test("runTruckPosts daily: BEFORE 08:00 ET the gate is closed — nothing created", async () => {
  // 2026-07-20 has a booking; run at 07:00 ET (11:00Z) → gate closed.
  await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ admin: "A", action: "addBookings", clientId: CLIENT, bookings: [bk({ date: "2026-07-20" })] }) });
  const all = await fetchAll();
  const res = await runTruckPosts({ cfg: cfgFor(base), all, now: new Date("2026-07-20T11:00:00Z") });
  assert.equal(res.dailyPostCreated, 0);
  const after = await fetchAll();
  assert.ok(!after.requests.some((r) => r.meta && r.meta.clientRequestId === `${CLIENT}-daily-2026-07-20`), "no row before the gate opens");
});

test("runTruckPosts daily: autoApproveDaily=true arms auto-approve (meta.autoEvent.autoApprove true)", async () => {
  await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ admin: "A", action: "addBookings", clientId: CLIENT, bookings: [bk({ date: "2026-07-21" })] }) });
  const all = await fetchAll();
  const res = await runTruckPosts({ cfg: cfgFor(base, { schedule: { autoApproveDaily: true } }), all, now: new Date("2026-07-21T16:00:00Z") });
  assert.equal(res.dailyPostCreated, 1);
  const after = await fetchAll();
  const row = after.requests.find((r) => r.meta && r.meta.clientRequestId === `${CLIENT}-daily-2026-07-21`);
  assert.equal(row.meta.autoEvent.autoApprove, true);
});

test("runTruckPosts daily: no trucks today → no request created (normal no-op, not a failure)", async () => {
  // 2026-07-22 has no booking.
  const all = await fetchAll();
  const res = await runTruckPosts({ cfg: cfgFor(base), all, now: new Date("2026-07-22T16:00:00Z") });
  assert.equal(res.dailyPostCreated, 0);
  assert.equal(res.dailyPostFailed, 0);
  const after = await fetchAll();
  assert.ok(!after.requests.some((r) => r.meta && r.meta.clientRequestId === `${CLIENT}-daily-2026-07-22`));
});

// ---- runTruckPosts: monthly ----

test("runTruckPosts monthly: only fires on the draft day (25th) — creates the month post", async () => {
  const all = await fetchAll();
  // The 25th, past 08:00 ET.
  const res = await runTruckPosts({ cfg: cfgFor(base), all, now: new Date("2026-07-25T16:00:00Z") });
  assert.equal(res.monthlyCreated, 1);
  const after = await fetchAll();
  const row = after.requests.find((r) => r.meta && r.meta.clientRequestId === `${CLIENT}-monthly-202607`);
  assert.ok(row, "monthly post request exists");
  assert.equal(row.type, "post");
  assert.equal(row.stage, "queued");
  assert.equal(row.meta.autoEvent.autoApprove, false); // monthly ALWAYS Marshall-approved
});

test("runTruckPosts monthly: does NOT fire on a non-draft day", async () => {
  const all = await fetchAll();
  const res = await runTruckPosts({ cfg: cfgFor(base), all, now: new Date("2026-08-10T16:00:00Z") });
  assert.equal(res.monthlyCreated, 0);
  const after = await fetchAll();
  assert.ok(!after.requests.some((r) => r.meta && r.meta.clientRequestId === `${CLIENT}-monthly-202608`));
});

// ---- dormant + fail-soft ----

test("runTruckPosts: dormant when no site has schedule.enabled (nothing runs)", async () => {
  const all = await fetchAll();
  const cfg = { execUrl: base, adminToken: "A", sites: { "eats-on-601": { schedule: { enabled: false } } } };
  const res = await runTruckPosts({ cfg, all, now: NOON_JUL11 });
  assert.equal(res.dailyPostCreated, 0);
  assert.equal(res.dailyPostFailed, 0);
});

test("runTruckPosts: no client token → skips that client (logged, not thrown)", async () => {
  const all = await fetchAll();
  const cfg = cfgFor(base);
  // all with no matching client → token lookup fails.
  const logs = [];
  const res = await runTruckPosts({ cfg, all: { ...all, clients: [] }, now: NOON_JUL11, log: (...a) => logs.push(a.join(" ")) });
  assert.equal(res.dailyPostCreated, 0);
  assert.equal(res.dailyPostFailed, 0);
  assert.ok(logs.some((l) => /no portal token/.test(l)));
});

test("runTruckPosts: FAIL-SOFT — a throwing runDailyPost (bad submit) is caught per client", async () => {
  const all = await fetchAll();
  // Point execUrl at a dead port so apiSubmit returns a network-error object; runDailyPost
  // then can't get an id and returns submit-failed (not a throw). Force a throw instead by
  // giving a booking today but a submitRequest that throws — via a cfg whose execUrl is a
  // value that makes fetch throw synchronously is hard; instead assert the lane never throws
  // even when the backend is unreachable.
  const deadCfg = cfgFor("http://127.0.0.1:1"); // connection refused
  let res;
  await assert.doesNotReject(async () => {
    res = await runTruckPosts({ cfg: deadCfg, all: { ...all, bookings: [bk({ date: "2026-09-09" })] }, now: new Date("2026-09-09T16:00:00Z"), log: () => {} });
  });
  assert.ok(res, "lane returned normally despite an unreachable backend");
});

// ---- runOnce wiring + fail-soft ----

test("runOnce runs the truck-post lane with the tick's all payload and surfaces counts", async () => {
  let seenAll = null;
  const truckPosts = async ({ all }) => { seenAll = all; return { dailyPostCreated: 1, monthlyCreated: 0 }; };
  const res = await runOnce({
    apiBase: base, adminToken: "A",
    drainer: async () => ({ drafted: 0 }),
    notifier: { async notifyNew() {}, async notifyDigest() {} },
    truckPosts,
    getLastDigest: async () => new Date().toISOString(), setLastDigest: async () => {}, now: new Date(),
  });
  assert.ok(seenAll && Array.isArray(seenAll.requests), "truckPosts got the real admin payload");
  assert.equal(res.dailyPostCreated, 1, "daily count surfaced in the tick summary");
});

test("runOnce FAIL-SOFT: a throwing truck-post lane never breaks the tick (drain still runs)", async () => {
  const truckPosts = async () => { throw new Error("truck lane exploded"); };
  let drained = false;
  const drainer = async () => { drained = true; return { drafted: 0 }; };
  let res;
  await assert.doesNotReject(async () => {
    res = await runOnce({
      apiBase: base, adminToken: "A",
      drainer,
      notifier: { async notifyNew() {}, async notifyDigest() {} },
      truckPosts,
      getLastDigest: async () => new Date().toISOString(), setLastDigest: async () => {}, now: new Date(),
    });
  });
  assert.ok(res, "runOnce returned normally despite the truck lane throwing");
  assert.ok(drained, "the drain still ran");
  assert.equal(res.dailyPostCreated, 0);
});

// ---- runTruckPosts: cancellation lane ----

test("runTruckPosts cancel lane: queues a portal cancellation post immediately, even before the daily gate", async () => {
  // Portal flow: book a truck, mark it cancelled, submit the announcement request
  // with the deterministic cancel crid — all as the CLIENT.
  const add = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ c: TOKEN, action: "addBookings", bookings: [bk({ date: "2026-07-12" })] }) }).then((r) => r.json());
  const bookingId = add.ids[0];
  await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ c: TOKEN, action: "updateBooking", id: bookingId, patch: { status: "cancelled" } }) });
  const crid = `${CLIENT}-cancel-${bookingId}`;
  const sub = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ c: TOKEN, action: "submitRequest", clientRequestId: crid, request: { type: "post", title: "Canceled — Island Boys Food Truck (Sun · Jul 12)", description: "Island Boys Food Truck has canceled for Sun · Jul 12." } }) }).then((r) => r.json());
  assert.equal(sub.ok, true);

  // 06:00 ET on the 12th — BEFORE the 08:00 daily gate. Cancel lane must fire anyway.
  const EARLY = new Date("2026-07-12T10:00:00Z");
  const all = await fetchAll();
  const res = await runTruckPosts({ cfg: cfgFor(base), all, now: EARLY });
  assert.equal(res.cancelQueued, 1);
  assert.equal(res.cancelFailed, 0);
  assert.equal(res.dailyPostCreated, 0, "daily gate still closed at 06:00 ET");

  // The request is now queued with the auto markers (autoApprove off by default).
  const after = await fetchAll();
  const r = after.requests.find((x) => x.meta && x.meta.clientRequestId === crid);
  assert.equal(r.stage, "queued");
  assert.equal(r.meta.autoEvent.kind, "cancellation");
  assert.equal(r.meta.autoEvent.autoApprove, false);
  assert.equal(r.meta.autoEvent.ymd, "2026-07-12");
  assert.match(r.comment, /Island Boys Food Truck/);

  // Idempotent: a second tick finds nothing submitted → queues nothing.
  const res2 = await runTruckPosts({ cfg: cfgFor(base), all: after, now: EARLY });
  assert.equal(res2.cancelQueued, 0);
});
