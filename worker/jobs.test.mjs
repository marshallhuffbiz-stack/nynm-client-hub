import { test } from "node:test";
import assert from "node:assert/strict";
import { detectJobs, shouldRunDigest, detectOrphans, planOrphanRecovery, enrichJobs, shouldNotifyReady } from "./jobs.mjs";

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

// --- otherOpenRequests (related-request awareness: kills duplicate drafts) ---

test("enrichJobs: otherOpenRequests lists the same client's OTHER open requests, compact shape", () => {
  const all = [
    { id: "r1", clientId: "the-o", type: "post", stage: "queued", createdAt: "2026-07-01T10:00:00Z", title: "Please post this", description: "Post the attached flyer" },
    { id: "r2", clientId: "the-o", type: "post", stage: "queued", createdAt: "2026-07-01T10:07:00Z", title: "Adding on", description: "Adding on to this. I was hoping you could also mention the drink special." },
    { id: "r3", clientId: "the-o", type: "design", stage: "ready", createdAt: "2026-06-30T09:00:00Z", title: "Menu board", description: "" },
    { id: "r4", clientId: "eats-on-601", type: "post", stage: "queued", createdAt: "2026-07-01T10:01:00Z", title: "Other client", description: "" }, // different client
    { id: "r5", clientId: "the-o", type: "post", stage: "done", createdAt: "2026-06-01T00:00:00Z", title: "Old", description: "" }, // closed stage
    { id: "r6", clientId: "the-o", type: "post", stage: "approved", createdAt: "2026-07-01T09:00:00Z", title: "Approved", description: "" }, // approved = past review, not foldable
  ];
  const [job] = enrichJobs([all[0]], [], [], all);
  assert.deepEqual(job.otherOpenRequests.map((o) => o.id), ["r2", "r3"]);
  const r2 = job.otherOpenRequests[0];
  assert.deepEqual(Object.keys(r2).sort(), ["createdAt", "description", "id", "stage", "title", "type"]);
  assert.equal(r2.stage, "queued");
  assert.equal(r2.type, "post");
  assert.equal(r2.createdAt, "2026-07-01T10:07:00Z");
  assert.match(r2.description, /Adding on to this/);
});

test("enrichJobs: otherOpenRequests covers submitted/queued/changes/drafting/ready and never the job itself", () => {
  const all = ["submitted", "queued", "changes", "drafting", "ready", "approved", "done", "error"].map((stage, i) => ({
    id: "x" + i, clientId: "c", type: "post", stage, createdAt: "2026-07-01T00:00:00Z", title: stage, description: "",
  }));
  const me = { id: "me", clientId: "c", type: "post", stage: "queued", title: "mine" };
  const [job] = enrichJobs([me], [], [], [...all, me]);
  assert.deepEqual(job.otherOpenRequests.map((o) => o.stage), ["submitted", "queued", "changes", "drafting", "ready"]);
  assert.ok(!job.otherOpenRequests.some((o) => o.id === "me"), "the job itself is never its own related request");
});

test("enrichJobs: otherOpenRequests truncates description to ~200 chars and is [] when nothing is open", () => {
  const long = "y".repeat(500);
  const all = [
    { id: "a", clientId: "c", type: "post", stage: "queued", description: long },
    { id: "b", clientId: "c", type: "post", stage: "queued", description: long },
  ];
  const [job] = enrichJobs([all[0]], [], [], all);
  assert.equal(job.otherOpenRequests[0].description.length, 200);
  const [lonely] = enrichJobs([{ id: "z", clientId: "solo", type: "post", stage: "queued" }], [], [], all.concat({ id: "z", clientId: "solo", stage: "queued" }));
  assert.deepEqual(lonely.otherOpenRequests, []);
});

test("enrichJobs: with no allRequests arg, siblings in the same batch still see each other (the duplicate-draft incident shape)", () => {
  const rows = [
    { id: "r1", clientId: "the-o", type: "post", stage: "queued", title: "Please post this" },
    { id: "r2", clientId: "the-o", type: "post", stage: "queued", title: "Adding on to this" },
  ];
  const [a, b] = enrichJobs(rows, [], []);
  assert.deepEqual(a.otherOpenRequests.map((o) => o.id), ["r2"]);
  assert.deepEqual(b.otherOpenRequests.map((o) => o.id), ["r1"]);
});

// --- shouldNotifyReady (folded placeholder drafts must not push "draft ready") ---

test("shouldNotifyReady: a 'Folded into …' placeholder draft is silent", () => {
  assert.equal(shouldNotifyReady({ summary: "Folded into req_123 — review that draft; this one needs nothing.", caption: "" }), false);
});

test("shouldNotifyReady: real drafts still notify (empty caption tolerated)", () => {
  assert.equal(shouldNotifyReady({ summary: "Flyer for trivia night", caption: "" }), true);
  assert.equal(shouldNotifyReady({ caption: "hello" }), true);
  assert.equal(shouldNotifyReady({}), true);
  assert.equal(shouldNotifyReady(null), true);
  assert.equal(shouldNotifyReady({ summary: "We folded into shape" }), true, "only a summary STARTING with 'Folded into' is a placeholder");
});
