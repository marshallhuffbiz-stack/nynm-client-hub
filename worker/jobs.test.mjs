import { test } from "node:test";
import assert from "node:assert/strict";
import { detectJobs, shouldRunDigest, detectOrphans, planOrphanRecovery, enrichJobs } from "./jobs.mjs";

test("detectJobs buckets requests by stage", () => {
  const reqs = [
    { id: "a", stage: "submitted", meta: {} },
    { id: "b", stage: "queued" },
    { id: "c", stage: "changes" },
    { id: "d", stage: "approved" },
    { id: "e", stage: "drafting" },
    { id: "f", stage: "done" },
    { id: "g", stage: "submitted", meta: { notified: true } },
  ];
  const j = detectJobs(reqs, { draft: 5, ship: 5 });
  assert.deepEqual(j.drafts.map((r) => r.id), ["b", "c"]);
  assert.deepEqual(j.ships.map((r) => r.id), ["d"]);
  assert.deepEqual(j.newSubmits.map((r) => r.id), ["a"]); // g already notified
});

test("detectJobs respects caps", () => {
  const reqs = Array.from({ length: 8 }, (_, i) => ({ id: "q" + i, stage: "queued" }));
  const j = detectJobs(reqs, { draft: 3, ship: 5 });
  assert.equal(j.drafts.length, 3);
});

test("detectJobs returns ships UNCAPPED (poller caps per lane to avoid starvation)", () => {
  const reqs = Array.from({ length: 8 }, (_, i) => ({ id: "a" + i, stage: "approved" }));
  const j = detectJobs(reqs, { draft: 5, ship: 5 });
  assert.equal(j.ships.length, 8);
});

test("shouldRunDigest fires once per day after the hour", () => {
  const now = new Date(2026, 5, 17, 9, 0); // 9am local
  assert.equal(shouldRunDigest(null, now, 8), true); // never run, past 8
  assert.equal(shouldRunDigest(new Date(2026, 5, 17, 8, 5).toISOString(), now, 8), false); // already ran today
  assert.equal(shouldRunDigest(new Date(2026, 5, 16, 8, 5).toISOString(), now, 8), true); // ran yesterday
  const early = new Date(2026, 5, 17, 7, 0);
  assert.equal(shouldRunDigest(null, early, 8), false); // before the hour
});

test("detectOrphans flags drafting rows with no live drain (older than the threshold)", () => {
  const now = new Date("2026-06-30T12:00:00.000Z");
  const reqs = [
    { id: "fresh", stage: "drafting", updatedAt: "2026-06-30T11:55:00.000Z" }, // 5 min ago — a live drain may own it
    { id: "stale", stage: "drafting", updatedAt: "2026-06-30T11:30:00.000Z" }, // 30 min ago — orphaned
    { id: "noTime", stage: "drafting" }, // no timestamp — treat as orphaned
    { id: "queued", stage: "queued", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "ready", stage: "ready", updatedAt: "2026-01-01T00:00:00.000Z" },
  ];
  const orphans = detectOrphans(reqs, now, 15 * 60 * 1000);
  assert.deepEqual(orphans.map((r) => r.id), ["stale", "noTime"]);
});

test("planOrphanRecovery re-queues an orphan and clears its stale error", () => {
  const [action] = planOrphanRecovery(
    [{ id: "x", stage: "drafting", meta: { run: { error: "Out of space", skill: "branded-social-post" } } }],
    3
  );
  assert.equal(action.id, "x");
  assert.equal(action.patch.stage, "queued");
  assert.equal(action.patch.draft, null);
  assert.equal(action.patch.meta.run.error, "");
  assert.equal(action.patch.meta.run.requeues, 1);
  assert.equal(action.patch.meta.run.skill, "branded-social-post"); // other meta preserved
});

test("planOrphanRecovery gives up (marks error) after maxRequeues to avoid a hot loop", () => {
  const [action] = planOrphanRecovery([{ id: "x", stage: "drafting", meta: { run: { requeues: 3 } } }], 3);
  assert.equal(action.patch.stage, "error");
  assert.match(action.patch.meta.run.error, /gave up/i);
});

test("detectOrphans also flags stale 'shipping' rows (crash mid-publish / failed done-writeback)", () => {
  const now = new Date("2026-06-30T12:00:00.000Z");
  const reqs = [
    { id: "freshShip", stage: "shipping", updatedAt: "2026-06-30T11:55:00.000Z" }, // 5 min ago — a live shipper may own it
    { id: "staleShip", stage: "shipping", updatedAt: "2026-06-30T11:30:00.000Z" }, // 30 min ago — stranded
    { id: "noTimeShip", stage: "shipping" }, // no timestamp — treat as orphaned
    { id: "doneRow", stage: "done", updatedAt: "2026-01-01T00:00:00.000Z" },
  ];
  const orphans = detectOrphans(reqs, now, 15 * 60 * 1000);
  assert.deepEqual(orphans.map((r) => r.id), ["staleShip", "noTimeShip"]);
});

test("planOrphanRecovery re-queues a 'shipping' orphan to the SHIP lane — draft kept, never re-drafted", () => {
  const [action] = planOrphanRecovery(
    [{ id: "s", stage: "shipping", draft: { caption: "approved creative" }, meta: { thread: [{ text: "hi" }], run: { error: "old" } } }],
    3
  );
  assert.equal(action.id, "s");
  assert.equal(action.patch.stage, "approved"); // back to the ship lane, NOT "queued"
  assert.ok(!("draft" in action.patch), "the approved draft must never be wiped");
  assert.equal(action.patch.meta.run.requeues, 1);
  assert.equal(action.patch.meta.run.error, "");
  assert.equal(action.patch.meta.run.phase, "publish");
  assert.match(action.patch.meta.run.warning, /postiz/i); // publish may have landed — tell the human to check
  assert.ok(action.patch.meta.thread, "existing meta preserved");
});

test("planOrphanRecovery gives up on a 'shipping' orphan after maxRequeues without wiping the draft", () => {
  const [action] = planOrphanRecovery([{ id: "s", stage: "shipping", draft: { caption: "x" }, meta: { run: { requeues: 3 } } }], 3);
  assert.equal(action.patch.stage, "error");
  assert.ok(!("draft" in action.patch), "draft survives the give-up too");
  assert.equal(action.patch.meta.run.phase, "publish");
  assert.match(action.patch.meta.run.error, /may or may not have completed.*postiz/i);
});

test("enrichJobs joins the client record: brandSlug, siteFolder, clientName reach the drain brief", () => {
  const clients = [{ clientId: "the-o", name: "The O", brandSlug: "the-o-brand", siteFolder: "/sites/the-o" }];
  const [job] = enrichJobs([{ id: "r1", clientId: "the-o", type: "post", title: "t" }], clients, []);
  assert.equal(job.brandSlug, "the-o-brand");
  assert.equal(job.siteFolder, "/sites/the-o");
  assert.equal(job.clientName, "The O");
  assert.equal(job.id, "r1"); // original row fields ride along untouched
});

test("enrichJobs: unknown client → empty brand fields, clientName falls back to clientId", () => {
  const [job] = enrichJobs([{ id: "r1", clientId: "ghost", type: "post" }], [], []);
  assert.equal(job.brandSlug, "");
  assert.equal(job.siteFolder, "");
  assert.equal(job.clientName, "ghost");
});

test("enrichJobs attaches the event (title/date/time/endTime) when the request has an eventId", () => {
  const events = [{ eventId: "evt1", clientId: "the-o", title: "Trivia Night", date: "2026-07-04", time: "19:00", endTime: "22:00", description: "weekly trivia" }];
  const [job] = enrichJobs([{ id: "r1", clientId: "the-o", type: "event-promo", eventId: "evt1" }], [], events);
  assert.deepEqual(job.event, { title: "Trivia Night", date: "2026-07-04", time: "19:00", endTime: "22:00", description: "weekly trivia" });
});

test("enrichJobs: no eventId or unknown eventId → no event key", () => {
  const [a, b] = enrichJobs(
    [{ id: "r1", clientId: "c", type: "post" }, { id: "r2", clientId: "c", type: "event-promo", eventId: "nope" }],
    [], [{ eventId: "evt1", title: "X", date: "2026-07-04" }]
  );
  assert.ok(!("event" in a));
  assert.ok(!("event" in b));
});
