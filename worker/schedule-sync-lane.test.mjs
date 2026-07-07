import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScheduleSync } from "./poller.mjs";
import { buildSchedule, makeScheduleIO } from "./schedule-sync.mjs";

const NOW = new Date("2026-07-07T12:00:00Z");

const VENDORS = [
  { id: "island-boys-food-truck", clientId: "eats-on-601", name: "Island Boys Food Truck", category: "CARIBBEAN", price: "$$", tagline: "Island eats", active: true },
  { id: "bella-sweet-boutique", clientId: "eats-on-601", name: "Bella Sweet Boutique", category: "DESSERTS", price: "$$", tagline: "Sweets", active: true },
  // A vendor for a DIFFERENT client — must be filtered out of the eats build.
  { id: "other-truck", clientId: "some-other-client", name: "Other Truck", category: "BBQ", price: "$", tagline: "x", active: true },
];

const BOOKINGS = [
  { id: "b1", clientId: "eats-on-601", vendorId: "island-boys-food-truck", vendorName: "Island Boys Food Truck", date: "2026-07-11", startTime: "11:00", endTime: "19:00", status: "scheduled" },
  { id: "b2", clientId: "eats-on-601", vendorId: "bella-sweet-boutique", vendorName: "Bella Sweet Boutique", date: "2026-07-11", startTime: "12:00", endTime: "17:00", status: "scheduled" },
  // A booking for a DIFFERENT client — must be filtered out of the eats build.
  { id: "b3", clientId: "some-other-client", vendorId: "other-truck", vendorName: "Other Truck", date: "2026-07-12", startTime: "10:00", endTime: "14:00", status: "scheduled" },
];

const CFG = {
  sites: {
    "eats-on-601": {
      dir: "/fake/eats",
      liveUrl: "https://eatson601.com",
      schedule: { enabled: true, scheduleFile: "src/content/schedule.json", vendorsFile: "src/content/vendors.json", projectVendors: false },
    },
  },
};

// Fake git/io/live matching reconcile's expected surface. The prepare fn returns these
// so the lane never touches a real repo or a live service.
function fakeGit() {
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
  };
}
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

test("lane: schedule changed → deploys (build filtered to the client, push+verify)", async () => {
  const git = fakeGit(), io = fakeIO({}, true), live = fakeLive(true);
  const prepared = [];
  const prepare = (clientId) => { prepared.push(clientId); return { git, io, live }; };

  const res = await runScheduleSync({ cfg: CFG, all: { bookings: BOOKINGS, vendors: VENDORS }, prepare, now: NOW });

  assert.equal(res.deployed, 1, "one client deployed");
  assert.equal(res.failed, 0);
  assert.deepEqual(prepared, ["eats-on-601"], "only the schedule-enabled client is prepared");
  assert.deepEqual(git.calls, ["add", "commit", "push"], "committed + pushed");
  assert.equal(live.calls.length, 1, "verified live");
  // The staged schedule must be filtered to this client only (2 vendors on 7/11, no other-client day).
  const staged = io.calls.flat().find((f) => f.rel === "src/content/schedule.json");
  const built = JSON.parse(staged.content);
  assert.equal(built.length, 1, "only the eats day, not the other client's day");
  assert.equal(built[0].date, "2026-07-11");
  assert.equal(built[0].vendors.length, 2);
});

test("lane: schedule unchanged → no-op (no commit/push/verify)", async () => {
  const built = buildSchedule(
    BOOKINGS.filter((b) => b.clientId === "eats-on-601"),
    VENDORS.filter((v) => v.clientId === "eats-on-601"),
    { now: NOW }
  );
  const current = { "src/content/schedule.json": JSON.stringify(built, null, 2) + "\n" };
  const git = fakeGit(), io = fakeIO(current, false), live = fakeLive(true);
  const res = await runScheduleSync({ cfg: CFG, all: { bookings: BOOKINGS, vendors: VENDORS }, prepare: () => ({ git, io, live }), now: NOW });

  assert.equal(res.deployed, 0, "nothing deployed");
  assert.equal(res.unchanged, 1, "counted as a no-op");
  assert.deepEqual(git.calls, [], "no git ops when unchanged");
  assert.deepEqual(live.calls, [], "no live check when unchanged");
});

test("lane: skips clients whose schedule.enabled is false or absent", async () => {
  const prepared = [];
  const prepare = (clientId) => { prepared.push(clientId); return { git: fakeGit(), io: fakeIO({}, true), live: fakeLive(true) }; };

  // enabled === false
  const cfgOff = { sites: { "eats-on-601": { ...CFG.sites["eats-on-601"], schedule: { ...CFG.sites["eats-on-601"].schedule, enabled: false } } } };
  const r1 = await runScheduleSync({ cfg: cfgOff, all: { bookings: BOOKINGS, vendors: VENDORS }, prepare, now: NOW });
  assert.equal(r1.deployed, 0);
  assert.deepEqual(prepared, [], "disabled client never prepared");

  // schedule key absent entirely (e.g. The O's site entry has no schedule block)
  const cfgAbsent = { sites: { "the-o": { dir: "/fake/the-o", liveUrl: "https://theo.com" } } };
  const r2 = await runScheduleSync({ cfg: cfgAbsent, all: { bookings: BOOKINGS, vendors: VENDORS }, prepare, now: NOW });
  assert.equal(r2.deployed, 0);
  assert.deepEqual(prepared, [], "client with no schedule block never prepared");
});

test("lane: FAIL-SOFT — a throwing reconcile/prepare is caught, never propagates", async () => {
  // prepare throws for this client — the lane must swallow it and keep going.
  const boom = () => { throw new Error("prepare exploded"); };
  let res;
  await assert.doesNotReject(async () => {
    res = await runScheduleSync({ cfg: CFG, all: { bookings: BOOKINGS, vendors: VENDORS }, prepare: boom, now: NOW });
  });
  assert.equal(res.deployed, 0);
  assert.equal(res.failed, 1, "the failure is counted, not thrown");
});

test("lane: EMPTY-GUARD — backend empty + existing NON-empty schedule.json → skip, no deploy", async () => {
  // No bookings for this client → buildSchedule returns []. The site already has a
  // non-empty bootstrap schedule.json. We must NOT overwrite it.
  const existing = [{ id: "2026-07-04", date: "2026-07-04", isoDate: "2026-07-04T09:00:00-04:00", display: "Sat · Jul 4", vendors: [{ id: "seed", name: "Seed Truck", category: "X", price: "$", hours: "11A–7P" }] }];
  const current = { "src/content/schedule.json": JSON.stringify(existing, null, 2) + "\n" };
  const git = fakeGit(), io = fakeIO(current, true), live = fakeLive(true);

  const res = await runScheduleSync({
    cfg: CFG,
    all: { bookings: [], vendors: [] }, // backend has no bookings yet
    prepare: () => ({ git, io, live }),
    now: NOW,
  });

  assert.equal(res.deployed, 0, "must NOT deploy an empty schedule over a real one");
  assert.equal(res.skipped, 1, "empty-guard tripped");
  assert.deepEqual(git.calls, [], "no commit/push — the bootstrap schedule is preserved");
  assert.deepEqual(io.calls, [], "never staged/applied");
  assert.deepEqual(live.calls, [], "never verified");
});

test("lane: empty backend + empty (or absent) site file → NOT a destructive overwrite, allowed to reconcile", async () => {
  // Empty backend AND empty current file → no data loss risk; reconcile no-ops naturally.
  const current = { "src/content/schedule.json": JSON.stringify([], null, 2) + "\n" };
  const git = fakeGit(), io = fakeIO(current, false), live = fakeLive(true);
  const res = await runScheduleSync({ cfg: CFG, all: { bookings: [], vendors: [] }, prepare: () => ({ git, io, live }), now: NOW });
  assert.equal(res.skipped, 0, "empty-guard only trips when the site file is NON-empty");
  assert.equal(res.unchanged, 1, "empty over empty is a plain no-op");
  assert.deepEqual(git.calls, []);
});

// makeScheduleIO is the real fs adapter reconcile uses on the poller. Exercise it against
// a temp dir so the read/apply round-trip is proven without a real site repo.
test("makeScheduleIO: readFile returns null for a missing file, then apply writes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ch-sched-io-"));
  try {
    const io = makeScheduleIO(dir);
    assert.equal(await io.readFile("src/content/schedule.json"), null, "missing file → null (new file)");
    const staged = [{ rel: "src/content/schedule.json", content: "[]\n" }];
    const r = await io.apply(staged);
    assert.equal(r.changed, true, "writing a new file counts as changed");
    assert.equal(await readFile(join(dir, "src/content/schedule.json"), "utf8"), "[]\n");
    // Re-applying identical content is a no-op (idempotent).
    const r2 = await io.apply(staged);
    assert.equal(r2.changed, false, "identical re-apply → unchanged");
    assert.equal(await io.readFile("src/content/schedule.json"), "[]\n", "readFile round-trips the written content");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
