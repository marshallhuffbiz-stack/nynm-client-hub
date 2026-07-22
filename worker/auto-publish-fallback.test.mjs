import { test } from "node:test";
import assert from "node:assert/strict";
import { fallbackConfig, fallbackCandidates, runAutoPublishFallback } from "./auto-publish-fallback.mjs";

const NOW = new Date("2026-07-22T18:00:00Z");
const iso = (minAgo) => new Date(NOW.getTime() - minAgo * 60 * 1000).toISOString();

const req = (over) => ({
  id: "req_1",
  clientId: "the-o",
  type: "post",
  stage: "submitted",
  title: "Trivia night post",
  createdAt: iso(90),
  meta: {},
  ...over,
});

const CFG = fallbackConfig({ enabled: true });

// ---- config defaults ----

test("fallbackConfig: defaults are 60min / warn 15 before / post+event-promo / 48h skip / cap 2", () => {
  const c = fallbackConfig({ enabled: true });
  assert.equal(c.enabled, true);
  assert.equal(c.afterMinutes, 60);
  assert.equal(c.warnBeforeMinutes, 15);
  assert.deepEqual(c.types, ["post", "event-promo"]);
  assert.equal(c.skipOlderThanHours, 48);
  assert.equal(c.capPerTick, 2);
  assert.equal(fallbackConfig().enabled, false);
  assert.equal(fallbackConfig(null).enabled, false);
});

// ---- candidates: age + stage gating ----

test("candidates: stale submitted post → send; fresh one → not yet", () => {
  const stale = req({ id: "a", createdAt: iso(61) });
  const fresh = req({ id: "b", createdAt: iso(59) });
  const out = fallbackCandidates([stale, fresh], CFG, NOW);
  assert.deepEqual(out.sends.map((r) => r.id), ["a"]);
  assert.deepEqual(out.approves, []);
});

test("candidates: stale ready post with a draft → approve; ready without draft is left alone", () => {
  const withDraft = req({ id: "a", stage: "ready", draft: { caption: "hi" } });
  const noDraft = req({ id: "b", stage: "ready", draft: null });
  const out = fallbackCandidates([withDraft, noDraft], CFG, NOW);
  assert.deepEqual(out.approves.map((r) => r.id), ["a"]);
  assert.deepEqual(out.sends, []);
});

test("candidates: other stages (queued/drafting/changes/approved/done/error) are never touched", () => {
  const rs = ["queued", "drafting", "changes", "approved", "shipping", "done", "error"].map((stage, i) =>
    req({ id: `r${i}`, stage, draft: { caption: "x" } })
  );
  const out = fallbackCandidates(rs, CFG, NOW);
  assert.deepEqual(out.sends, []);
  assert.deepEqual(out.approves, []);
});

// ---- candidates: scope guards ----

test("candidates: only configured types; design/website excluded", () => {
  const rs = [
    req({ id: "a", type: "post" }),
    req({ id: "b", type: "event-promo" }),
    req({ id: "c", type: "design" }),
    req({ id: "d", type: "website" }),
  ];
  const out = fallbackCandidates(rs, CFG, NOW);
  assert.deepEqual(out.sends.map((r) => r.id), ["a", "b"]);
});

test("candidates: auto-events-owned requests (meta.autoEvent.autoApprove) are excluded; checked-not-confident ones are eligible", () => {
  const owned = req({ id: "a", stage: "ready", draft: { caption: "x" }, meta: { autoEvent: { autoApprove: true } } });
  const checkedOnly = req({ id: "b", stage: "ready", draft: { caption: "x" }, meta: { autoEvent: { checked: true, confident: false } } });
  const out = fallbackCandidates([owned, checkedOnly], CFG, NOW);
  assert.deepEqual(out.approves.map((r) => r.id), ["b"]);
});

test("candidates: rows older than skipOlderThanHours are parked, not resurrected", () => {
  const parked = req({ id: "a", createdAt: iso(49 * 60) });
  const live = req({ id: "b", createdAt: iso(90) });
  const out = fallbackCandidates([parked, live], CFG, NOW);
  assert.deepEqual(out.sends.map((r) => r.id), ["b"]);
});

test("candidates: missing/invalid createdAt is never eligible (fail closed)", () => {
  const out = fallbackCandidates([req({ createdAt: "" }), req({ createdAt: "not-a-date" })], CFG, NOW);
  assert.deepEqual(out.sends, []);
  assert.deepEqual(out.warns, []);
});

test("candidates: already-actioned markers are idempotent (sentAt blocks re-send, approvedAt blocks re-approve)", () => {
  const sent = req({ id: "a", meta: { autoPublishFallback: { sentAt: iso(5) } } });
  const approved = req({ id: "b", stage: "ready", draft: { caption: "x" }, meta: { autoPublishFallback: { approvedAt: iso(5) } } });
  const out = fallbackCandidates([sent, approved], CFG, NOW);
  assert.deepEqual(out.sends, []);
  assert.deepEqual(out.approves, []);
});

// ---- candidates: warning window ----

test("candidates: warn fires only inside [after-warnBefore, after) and only once", () => {
  const tooFresh = req({ id: "a", createdAt: iso(40) });
  const inWindow = req({ id: "b", createdAt: iso(50) });
  const warned = req({ id: "c", createdAt: iso(50), meta: { autoPublishFallback: { warnedAt: iso(2) } } });
  const past = req({ id: "d", createdAt: iso(65) }); // past the deadline → it's a send, not a warn
  const out = fallbackCandidates([tooFresh, inWindow, warned, past], CFG, NOW);
  assert.deepEqual(out.warns.map((r) => r.id), ["b"]);
  assert.deepEqual(out.sends.map((r) => r.id), ["d"]);
});

test("candidates: ready-stage requests get the warning too", () => {
  const r = req({ id: "a", stage: "ready", draft: { caption: "x" }, createdAt: iso(50) });
  const out = fallbackCandidates([r], CFG, NOW);
  assert.deepEqual(out.warns.map((x) => x.id), ["a"]);
});

test("candidates: capPerTick limits sends and approves (oldest first), warns uncapped", () => {
  const rs = [
    req({ id: "s1", createdAt: iso(70) }),
    req({ id: "s2", createdAt: iso(80) }),
    req({ id: "s3", createdAt: iso(90) }),
    req({ id: "a1", stage: "ready", draft: { caption: "x" }, createdAt: iso(75) }),
    req({ id: "a2", stage: "ready", draft: { caption: "x" }, createdAt: iso(85) }),
    req({ id: "a3", stage: "ready", draft: { caption: "x" }, createdAt: iso(95) }),
  ];
  const out = fallbackCandidates(rs, CFG, NOW);
  assert.deepEqual(out.sends.map((r) => r.id), ["s3", "s2"]);
  assert.deepEqual(out.approves.map((r) => r.id), ["a3", "a2"]);
});

test("candidates: disabled config returns nothing", () => {
  const out = fallbackCandidates([req()], fallbackConfig({ enabled: false }), NOW);
  assert.deepEqual(out, { sends: [], approves: [], warns: [] });
});

// ---- runner: patches, notifications, counters ----

function harness() {
  const updates = [];
  const pushes = [];
  return {
    updates,
    pushes,
    apiUpdate: async (base, token, id, patch) => {
      updates.push({ id, patch });
      return { ok: true };
    },
    notify: async (title, message, opts) => {
      pushes.push({ title, message, opts });
      return true;
    },
  };
}

test("run: stale submitted → action:send with marker meta + a push", async () => {
  const h = harness();
  const r = req({ id: "a", meta: { notified: true } });
  const res = await runAutoPublishFallback({
    apiBase: "b", adminToken: "t", requests: [r], cfg: CFG,
    apiUpdate: h.apiUpdate, notify: h.notify, now: () => NOW,
  });
  assert.equal(res.sent, 1);
  assert.equal(h.updates.length, 1);
  const { id, patch } = h.updates[0];
  assert.equal(id, "a");
  assert.equal(patch.action, "send");
  assert.equal(patch.meta.notified, true); // existing meta preserved
  assert.equal(patch.meta.autoPublishFallback.sentAt, NOW.toISOString());
  assert.ok(patch.comment && /auto/i.test(patch.comment));
  assert.equal(h.pushes.length, 1);
  assert.match(h.pushes[0].title, /auto/i);
});

test("run: stale ready → action:approve, drafter's scheduledFor stripped, marker meta, push", async () => {
  const h = harness();
  const r = req({
    id: "a", stage: "ready",
    draft: { caption: "hi", scheduledFor: "2026-07-23T13:00:00Z" },
    meta: { notified: true },
  });
  const res = await runAutoPublishFallback({
    apiBase: "b", adminToken: "t", requests: [r], cfg: CFG,
    apiUpdate: h.apiUpdate, notify: h.notify, now: () => NOW,
  });
  assert.equal(res.approved, 1);
  const { patch } = h.updates[0];
  assert.equal(patch.action, "approve");
  assert.equal(patch.draft.caption, "hi");
  assert.equal("scheduledFor" in patch.draft, false);
  assert.equal(patch.meta.autoPublishFallback.approvedAt, NOW.toISOString());
  assert.equal(h.pushes.length, 1);
});

test("run: warn window → meta-only patch (no action) + high-priority push, once", async () => {
  const h = harness();
  const r = req({ id: "a", createdAt: iso(50) });
  const res = await runAutoPublishFallback({
    apiBase: "b", adminToken: "t", requests: [r], cfg: CFG,
    apiUpdate: h.apiUpdate, notify: h.notify, now: () => NOW,
  });
  assert.equal(res.warned, 1);
  const { patch } = h.updates[0];
  assert.equal(patch.action, undefined);
  assert.equal(patch.stage, undefined);
  assert.equal(patch.meta.autoPublishFallback.warnedAt, NOW.toISOString());
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0].opts && h.pushes[0].opts.priority, "high");
  assert.match(h.pushes[0].message, /15 min/);
});

test("run: a failing apiUpdate on one request doesn't block the others (fail-soft per row)", async () => {
  const h = harness();
  let n = 0;
  const flaky = async (base, token, id, patch) => {
    n += 1;
    if (id === "bad") throw new Error("boom");
    return h.apiUpdate(base, token, id, patch);
  };
  const rs = [req({ id: "bad", createdAt: iso(70) }), req({ id: "good", createdAt: iso(90) })];
  const res = await runAutoPublishFallback({
    apiBase: "b", adminToken: "t", requests: rs, cfg: CFG,
    apiUpdate: flaky, notify: h.notify, now: () => NOW,
  });
  assert.equal(res.sent, 1);
  assert.equal(res.failed, 1);
  assert.equal(n, 2);
});

test("run: disabled → zero work, zero calls", async () => {
  const h = harness();
  const res = await runAutoPublishFallback({
    apiBase: "b", adminToken: "t", requests: [req()], cfg: fallbackConfig(),
    apiUpdate: h.apiUpdate, notify: h.notify, now: () => NOW,
  });
  assert.deepEqual(res, { warned: 0, sent: 0, approved: 0, failed: 0 });
  assert.equal(h.updates.length, 0);
  assert.equal(h.pushes.length, 0);
});

// ---- integration: the real backend (mock-server mirrors Code.gs) accepts our patch shapes ----

test("integration: fallback send + approve patches walk a request through the real state machine", async (t) => {
  const { mkdtemp, writeFile: wf, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createApp } = await import("../mock-server/server.mjs");
  const { apiUpdate } = await import("./writeback.mjs");

  const dir = await mkdtemp(join(tmpdir(), "ch-fallback-"));
  await wf(
    join(dir, "store.json"),
    JSON.stringify({
      settings: { adminToken: "A" },
      clients: [{ clientId: "the-o", name: "The O", token: "t", active: true }],
      requests: [
        { id: "f1", clientId: "the-o", type: "post", title: "stale submitted", stage: "submitted", createdAt: iso(90), meta: { notified: true } },
        { id: "f2", clientId: "the-o", type: "post", title: "stale ready", stage: "ready", createdAt: iso(90), draft: { caption: "hi", scheduledFor: "2026-07-23T13:00:00Z" }, meta: { notified: true } },
      ],
      events: [],
    })
  );
  const srv = createApp({ storePath: join(dir, "store.json") });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  t.after(async () => { await new Promise((r) => srv.close(r)); await rm(dir, { recursive: true, force: true }); });

  const all = await fetch(`${base}/?admin=A`).then((r) => r.json());
  const res = await runAutoPublishFallback({
    apiBase: base, adminToken: "A", requests: all.requests, cfg: CFG,
    apiUpdate, notify: async () => true, now: () => NOW,
  });
  assert.equal(res.sent, 1);
  assert.equal(res.approved, 1);
  assert.equal(res.failed, 0);

  const after = await fetch(`${base}/?admin=A`).then((r) => r.json());
  const byId = Object.fromEntries(after.requests.map((r) => [r.id, r]));
  assert.equal(byId.f1.stage, "queued");
  assert.equal(byId.f1.meta.autoPublishFallback.sentAt, NOW.toISOString());
  assert.equal(byId.f2.stage, "approved");
  assert.equal(byId.f2.draft.scheduledFor, undefined);
  assert.equal(byId.f2.meta.autoPublishFallback.approvedAt, NOW.toISOString());
});
