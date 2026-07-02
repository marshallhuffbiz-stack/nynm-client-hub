import { test } from "node:test";
import assert from "node:assert/strict";
import { errorPatch } from "./wb-core.mjs";

const NOW = "2026-07-01T12:00:00.000Z";

test("errorPatch merges into the row's existing meta instead of clobbering it", () => {
  const currentMeta = {
    thread: [{ at: "t0", from: "client", text: "make it brighter" }],
    activity: [{ at: "t0", kind: "created" }],
    notified: true,
    clientRequestId: "abc-123",
    autoEvent: { key: "eats|2026-07-04|jeep-jam" },
    run: { requeues: 2, skill: "branded-social-post" },
  };
  const p = errorPatch(currentMeta, "render blew up", NOW);
  assert.equal(p.action, "error");
  assert.deepEqual(p.meta.thread, currentMeta.thread, "thread survives");
  assert.deepEqual(p.meta.activity, currentMeta.activity, "activity survives");
  assert.equal(p.meta.notified, true, "notified flag survives (no duplicate push next tick)");
  assert.equal(p.meta.clientRequestId, "abc-123", "submit idempotency key survives");
  assert.deepEqual(p.meta.autoEvent, currentMeta.autoEvent, "autoEvent survives");
  assert.equal(p.meta.run.requeues, 2, "orphan-recovery counter survives");
  assert.equal(p.meta.run.skill, "branded-social-post", "prior run fields survive");
  assert.equal(p.meta.run.status, "error");
  assert.equal(p.meta.run.error, "render blew up");
  assert.equal(p.meta.run.phase, "draft"); // drain failures are draft-phase (see planRequeue)
  assert.equal(p.meta.run.finishedAt, NOW);
});

test("errorPatch tolerates a missing/empty current meta and empty message", () => {
  const p = errorPatch(null, "", NOW);
  assert.equal(p.action, "error");
  assert.equal(p.meta.run.status, "error");
  assert.equal(p.meta.run.error, "drain error");
  assert.equal(p.meta.run.finishedAt, NOW);
});
