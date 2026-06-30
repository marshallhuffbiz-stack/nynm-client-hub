import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../mock-server/server.mjs";
import { runOnce, preflightDisk, isLiveProcess, drainArgs } from "./poller.mjs";
import { apiUpdate } from "./writeback.mjs";

let srv, base, dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "ch-worker-"));
  const storePath = join(dir, "store.json");
  await writeFile(
    storePath,
    JSON.stringify({
      settings: { adminToken: "A" },
      clients: [{ clientId: "the-o", name: "The O", token: "t", active: true }],
      requests: [
        { id: "s1", clientId: "the-o", type: "post", title: "new one", stage: "submitted", meta: {} },
        { id: "q1", clientId: "the-o", type: "design", title: "draft me", stage: "queued", meta: {} },
        { id: "a1", clientId: "the-o", type: "post", title: "ship me", stage: "approved", meta: {} },
      ],
      events: [],
    })
  );
  srv = createApp({ storePath });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(async () => {
  await new Promise((r) => srv.close(r));
  await rm(dir, { recursive: true, force: true });
});

test("runOnce notifies new, drafts queued, ships approved, sends digest", async () => {
  const notified = [];
  let digestCalled = 0;
  const notifier = {
    async notifyNew(r) { notified.push(r.id); },
    async notifyDigest() { digestCalled++; },
  };
  // Stub drainer = the headless Claude drain (drafts only now; social ships go to the shipper).
  const drainer = async ({ apiBase, adminToken, drafts }) => {
    for (const d of drafts) {
      await apiUpdate(apiBase, adminToken, d.id, { action: "start" });
      await apiUpdate(apiBase, adminToken, d.id, { action: "ready", draft: { caption: "stub" } });
    }
    return { drafted: drafts.length };
  };
  // Stub shipper = the deterministic ship path; publishes approved social posts.
  const shipper = async ({ apiBase, adminToken, ships }) => {
    for (const s of ships) {
      await apiUpdate(apiBase, adminToken, s.id, { action: "ship" });
      await apiUpdate(apiBase, adminToken, s.id, { action: "done" });
    }
    return { shipped: ships.length, failed: 0 };
  };
  let lastDigest = null;
  const res = await runOnce({
    apiBase: base,
    adminToken: "A",
    caps: { draft: 5, ship: 5 },
    drainer,
    shipper,
    notifier,
    digestHour: 0,
    getLastDigest: async () => lastDigest,
    setLastDigest: async (v) => { lastDigest = v; },
    now: new Date(),
  });

  assert.deepEqual(notified, ["s1"]);
  assert.equal(res.drafts, 1);
  assert.equal(res.ships, 1);
  assert.equal(res.published, 1);
  assert.equal(res.digest, true);
  assert.equal(digestCalled, 1);

  const all = await fetch(`${base}/?admin=A`).then((r) => r.json());
  const byId = Object.fromEntries(all.requests.map((r) => [r.id, r]));
  assert.equal(byId.s1.meta.notified, true);
  assert.equal(byId.q1.stage, "ready");
  assert.equal(byId.q1.draft.caption, "stub");
  assert.equal(byId.a1.stage, "done");
});

test("preflightDisk: ample disk is ok; low disk skips WITHOUT touching the queue", async () => {
  const created = await fetch(base, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ admin: "A", action: "submitRequest", request: { clientId: "the-o", type: "post", description: "disk guard test" } }),
  }).then((r) => r.json());
  const id = created.id;
  await apiUpdate(base, "A", id, { action: "send" }); // submitted -> queued

  // Ample free space -> ok, request stays queued.
  const ample = await preflightDisk({
    apiBase: base, adminToken: "A", minFreeBytes: 1024, dir: ".",
    statfsFn: async () => ({ bavail: 1_000_000, bsize: 4096 }), notifier: {},
  });
  assert.equal(ample.ok, true);
  let all = await fetch(`${base}/?admin=A`).then((r) => r.json());
  assert.equal(all.requests.find((r) => r.id === id).stage, "queued");

  // Low free space -> SKIP the tick, but NEVER flip the row to error. Leaving it
  // queued means the worker auto-resumes once disk frees — this is the fix for the
  // queued->error->Retry->drafting trap that stranded requests.
  const low = await preflightDisk({
    apiBase: base, adminToken: "A", minFreeBytes: 2 * 1024 ** 3, dir: ".",
    statfsFn: async () => ({ bavail: 25_600, bsize: 4096 }), notifier: {}, // ~100 MB free
  });
  assert.equal(low.ok, false);
  assert.equal(low.skipped, true);
  all = await fetch(`${base}/?admin=A`).then((r) => r.json());
  assert.equal(all.requests.find((r) => r.id === id).stage, "queued"); // untouched, NOT error
});

test("preflightDisk leaves ALL rows untouched on low disk (incl. a drafting row)", async () => {
  const created = await fetch(base, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ admin: "A", action: "submitRequest", request: { clientId: "the-o", type: "post", description: "drafting guard test" } }),
  }).then((r) => r.json());
  const id = created.id;
  await apiUpdate(base, "A", id, { action: "send" });  // submitted -> queued
  await apiUpdate(base, "A", id, { action: "start" }); // queued -> drafting (a live drain owns it)
  const low = await preflightDisk({
    apiBase: base, adminToken: "A", minFreeBytes: 2 * 1024 ** 3, dir: ".",
    statfsFn: async () => ({ bavail: 25_600, bsize: 4096 }), notifier: {},
  });
  assert.equal(low.ok, false);
  const all = await fetch(`${base}/?admin=A`).then((r) => r.json());
  assert.equal(all.requests.find((r) => r.id === id).stage, "drafting"); // untouched
});

test("drainArgs pins the model when configured, omits --model otherwise", () => {
  assert.deepEqual(
    drainArgs({ drainPrompt: "P", settingsPath: "/s.json", model: "claude-opus-4-8" }),
    ["-p", "P", "--settings", "/s.json", "--model", "claude-opus-4-8"]
  );
  const without = drainArgs({ drainPrompt: "P", settingsPath: "/s.json" });
  assert.deepEqual(without, ["-p", "P", "--settings", "/s.json"]);
  assert.ok(!without.includes("--model"));
});

test("isLiveProcess tells a live pid from a stale/empty lock", () => {
  assert.equal(isLiveProcess(process.pid), true);
  assert.equal(isLiveProcess(2147483646), false); // a pid that is not running
  assert.equal(isLiveProcess(""), false);
  assert.equal(isLiveProcess("nope"), false);
});

test("runOnce auto-recovers an orphaned 'drafting' row by re-queueing it", async () => {
  const created = await fetch(base, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ admin: "A", action: "submitRequest", request: { clientId: "the-o", type: "post", description: "orphan recovery test" } }),
  }).then((r) => r.json());
  const id = created.id;
  await apiUpdate(base, "A", id, { action: "send" });  // submitted -> queued
  await apiUpdate(base, "A", id, { action: "start" }); // queued -> drafting, but no live drain will finish it

  // drainer stub does nothing (no live drain) — the row would be stranded forever
  // without orphan recovery.
  const drainer = async () => ({ drafted: 0 });
  const res = await runOnce({
    apiBase: base, adminToken: "A", caps: { draft: 5, ship: 5 },
    drainer, notifier: { async notifyNew() {}, async notifyDigest() {} },
    orphanMaxAgeMs: 0, maxRequeues: 3,
    now: new Date(Date.now() + 60_000), // a minute later, so the just-set drafting row is past the (0ms) threshold
  });
  assert.ok(res.recovered >= 1);
  const all = await fetch(`${base}/?admin=A`).then((r) => r.json());
  assert.equal(all.requests.find((r) => r.id === id).stage, "queued"); // re-queued, no longer stranded
});
