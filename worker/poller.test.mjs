import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../mock-server/server.mjs";
import { runOnce } from "./poller.mjs";
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
  // Stub drainer = what the headless Claude drain does, via the real API.
  const drainer = async ({ apiBase, adminToken, drafts, ships }) => {
    for (const d of drafts) {
      await apiUpdate(apiBase, adminToken, d.id, { action: "start" });
      await apiUpdate(apiBase, adminToken, d.id, { action: "ready", draft: { caption: "stub" } });
    }
    for (const s of ships) {
      await apiUpdate(apiBase, adminToken, s.id, { action: "ship" });
      await apiUpdate(apiBase, adminToken, s.id, { action: "done" });
    }
    return { drafted: drafts.length, shipped: ships.length };
  };
  let lastDigest = null;
  const res = await runOnce({
    apiBase: base,
    adminToken: "A",
    caps: { draft: 5, ship: 5 },
    drainer,
    notifier,
    digestHour: 0,
    getLastDigest: async () => lastDigest,
    setLastDigest: async (v) => { lastDigest = v; },
    now: new Date(),
  });

  assert.deepEqual(notified, ["s1"]);
  assert.equal(res.drafts, 1);
  assert.equal(res.ships, 1);
  assert.equal(res.digest, true);
  assert.equal(digestCalled, 1);

  const all = await fetch(`${base}/?admin=A`).then((r) => r.json());
  const byId = Object.fromEntries(all.requests.map((r) => [r.id, r]));
  assert.equal(byId.s1.meta.notified, true);
  assert.equal(byId.q1.stage, "ready");
  assert.equal(byId.q1.draft.caption, "stub");
  assert.equal(byId.a1.stage, "done");
});
