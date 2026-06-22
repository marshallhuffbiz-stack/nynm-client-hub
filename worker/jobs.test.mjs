import { test } from "node:test";
import assert from "node:assert/strict";
import { detectJobs, shouldRunDigest } from "./jobs.mjs";

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
