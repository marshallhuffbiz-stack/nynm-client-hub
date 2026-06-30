import { test } from "node:test";
import assert from "node:assert/strict";
import { detectJobs, shouldRunDigest, detectOrphans, planOrphanRecovery } from "./jobs.mjs";

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
