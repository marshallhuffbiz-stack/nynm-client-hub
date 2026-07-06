import { test } from "node:test";
import assert from "node:assert/strict";
import { applySiteChange, verifyLive, makeSiteShipper } from "./site-apply.mjs";

const MANIFEST = {
  files: ["src/content/vendors.json"],
  commitMessage: "Remove vendor Arron Side Chicks from site",
  verify: { absentOnLive: ["Arron Side Chicks"], presentOnLive: [] },
};

// Injected git adapter (mirrors site-sync.test.mjs). All ops async → {ok,out,err}.
function fakeGit(over = {}) {
  const calls = [];
  const ok = (out = "") => async () => ({ ok: true, out });
  return {
    calls,
    branch: ok("main"),
    status: ok(""), // status(paths) → "" means clean
    pull: ok(""),
    add: async () => { calls.push("add"); return { ok: true, out: "" }; },
    commit: async () => { calls.push("commit"); return { ok: true, out: "" }; },
    push: async () => { calls.push("push"); return { ok: true, out: "" }; },
    ...over,
  };
}

// Injected files IO: apply() copies the manifest's scratch files into the repo and
// reports whether the repo content actually changed (idempotency signal).
function fakeIO(changed = true) {
  const calls = [];
  return { calls, apply: async (files) => { calls.push(files); return { changed }; } };
}

// Injected live verifier: check() polls the live URL for the verify assertions.
function fakeLive(ok = true, reason = "not live") {
  const calls = [];
  return { url: "https://eatson601.com", calls, check: async (v) => { calls.push(v); return { ok, reason: ok ? "" : reason }; } };
}

test("applySiteChange: clean main, change applies, push ok, live verified → done-worthy", async () => {
  const git = fakeGit();
  const io = fakeIO(true);
  const live = fakeLive(true);
  const res = await applySiteChange({ manifest: MANIFEST, git, io, live });
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  assert.equal(res.verified, true);
  assert.deepEqual(git.calls, ["add", "commit", "push"]);
  assert.deepEqual(io.calls, [MANIFEST.files]); // only the manifest files touched
  assert.deepEqual(live.calls, [MANIFEST.verify]); // verified against the drain's assertions
});

test("applySiteChange: not on main → skipped, nothing applied or committed", async () => {
  const git = fakeGit({ branch: async () => ({ ok: true, out: "some-branch" }) });
  const io = fakeIO(true);
  const live = fakeLive(true);
  const res = await applySiteChange({ manifest: MANIFEST, git, io, live });
  assert.equal(res.ok, false);
  assert.equal(res.skipped, true);
  assert.match(res.reason, /not on main/);
  assert.deepEqual(io.calls, []);
  assert.deepEqual(git.calls, []);
});

test("applySiteChange: target file has uncommitted changes → skipped (never clobbers WIP)", async () => {
  const git = fakeGit({ status: async () => ({ ok: true, out: " M src/content/vendors.json" }) });
  const io = fakeIO(true);
  const res = await applySiteChange({ manifest: MANIFEST, git, io, live: fakeLive(true) });
  assert.equal(res.skipped, true);
  assert.match(res.reason, /uncommitted local changes/);
  assert.deepEqual(io.calls, []);
  assert.deepEqual(git.calls, []);
});

test("applySiteChange: pull fails → skipped, nothing committed", async () => {
  const git = fakeGit({ pull: async () => ({ ok: false, err: "conflict" }) });
  const res = await applySiteChange({ manifest: MANIFEST, git, io: fakeIO(true), live: fakeLive(true) });
  assert.equal(res.skipped, true);
  assert.match(res.reason, /pull failed/);
});

test("applySiteChange: already applied (no change) but live verifies → ok, no commit/push", async () => {
  const git = fakeGit();
  const io = fakeIO(false); // repo already matches scratch → nothing to commit
  const live = fakeLive(true);
  const res = await applySiteChange({ manifest: MANIFEST, git, io, live });
  assert.equal(res.ok, true);
  assert.equal(res.changed, false);
  assert.equal(res.verified, true);
  assert.deepEqual(git.calls, []); // never re-commits
  assert.deepEqual(live.calls, [MANIFEST.verify]); // still confirms it's actually live
});

test("applySiteChange: push fails → not ok, not verified, reason names push", async () => {
  const git = fakeGit({ push: async () => ({ ok: false, err: "rejected: non-fast-forward" }) });
  const live = fakeLive(true);
  const res = await applySiteChange({ manifest: MANIFEST, git, io: fakeIO(true), live });
  assert.equal(res.ok, false);
  assert.equal(res.verified, false);
  assert.match(res.reason, /push failed/);
  assert.deepEqual(live.calls, []); // never claims live when the push didn't land
});

test("applySiteChange: pushed but live never confirms → not ok, pushed:true, not verified", async () => {
  const git = fakeGit();
  const live = fakeLive(false, "still shows Arron Side Chicks after 3m");
  const res = await applySiteChange({ manifest: MANIFEST, git, io: fakeIO(true), live });
  assert.equal(res.ok, false);
  assert.equal(res.pushed, true);
  assert.equal(res.verified, false);
  assert.match(res.reason, /not confirmed live/i);
  assert.deepEqual(git.calls, ["add", "commit", "push"]); // it DID push
});

// ---- verifyLive: the real live-poll loop (fetch + retry) ----

test("verifyLive: absent string still on page, then gone next poll → ok after retry", async () => {
  let call = 0;
  const pages = ["<p>Arron Side Chicks</p>", "<p>other vendors</p>"];
  const fetchImpl = async () => ({ ok: true, text: async () => pages[Math.min(call++, pages.length - 1)] });
  const sleeps = [];
  const res = await verifyLive({
    url: "https://eatson601.com",
    absentOnLive: ["Arron Side Chicks"],
    presentOnLive: [],
    fetchImpl,
    attempts: 5,
    delayMs: 1,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(res.ok, true);
  assert.equal(call, 2); // needed a second poll
  assert.equal(sleeps.length, 1); // slept once between polls
});

test("verifyLive: required present string never appears → not ok with reason", async () => {
  const fetchImpl = async () => ({ ok: true, text: async () => "<p>nothing here</p>" });
  const res = await verifyLive({
    url: "https://eatson601.com",
    absentOnLive: [],
    presentOnLive: ["New Vendor"],
    fetchImpl,
    attempts: 3,
    delayMs: 1,
    sleep: async () => {},
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /New Vendor/);
});

test("verifyLive: nothing to assert → ok immediately (single fetch, no strings)", async () => {
  let call = 0;
  const fetchImpl = async () => { call++; return { ok: true, text: async () => "" }; };
  const res = await verifyLive({ url: "x", absentOnLive: [], presentOnLive: [], fetchImpl, attempts: 3, delayMs: 1, sleep: async () => {} });
  assert.equal(res.ok, true);
  assert.equal(call, 1);
});

// ---- makeSiteShipper: turns an applySiteChange result into the right stage writeback ----

function recorder() {
  const patches = [];
  return { patches, apiUpdate: async (_base, _tok, id, patch) => { patches.push({ id, patch }); return { ok: true }; } };
}
const OK_PREP = async () => ({ manifest: {}, git: {}, io: {}, live: {}, liveUrl: "https://eatson601.com" });

test("makeSiteShipper: verified deploy → ship then done", async () => {
  const { patches, apiUpdate } = recorder();
  const ship = makeSiteShipper({ apiUpdate, prepare: OK_PREP, apply: async () => ({ ok: true, changed: true, verified: true }) });
  const res = await ship({ apiBase: "b", adminToken: "A", ships: [{ id: "w1", meta: {} }] });
  assert.equal(res.deployed, 1);
  assert.equal(res.failed, 0);
  assert.deepEqual(patches.map((p) => p.patch.action || p.patch.stage), ["ship", "done"]);
});

test("makeSiteShipper: transient guard (not on main) → left approved to retry, NOT errored", async () => {
  const { patches, apiUpdate } = recorder();
  const ship = makeSiteShipper({ apiUpdate, prepare: OK_PREP, apply: async () => ({ ok: false, skipped: true, reason: "not on main" }) });
  const res = await ship({ apiBase: "b", adminToken: "A", ships: [{ id: "w1", meta: {} }] });
  assert.equal(res.deferred, 1);
  assert.equal(res.failed, 0);
  assert.equal(patches[0].patch.action, "ship");
  assert.equal(patches[1].patch.stage, "approved");
  assert.ok(!patches.some((p) => p.patch.action === "done"));
});

test("makeSiteShipper: pushed but live never confirmed → error, NEVER done", async () => {
  const { patches, apiUpdate } = recorder();
  const ship = makeSiteShipper({ apiUpdate, prepare: OK_PREP, apply: async () => ({ ok: false, pushed: true, verified: false, reason: "not confirmed live" }) });
  const res = await ship({ apiBase: "b", adminToken: "A", ships: [{ id: "w1", meta: {} }] });
  assert.equal(res.failed, 1);
  assert.equal(res.deployed, 0);
  const last = patches[patches.length - 1];
  assert.equal(last.patch.stage, "error");
  assert.match(last.patch.meta.run.error, /not confirmed live/);
  assert.ok(!patches.some((p) => p.patch.action === "done"));
});

test("makeSiteShipper: missing manifest (prepare error) → error, no ship attempted", async () => {
  const { patches, apiUpdate } = recorder();
  const ship = makeSiteShipper({ apiUpdate, prepare: async () => ({ error: "no manifest at worker/out/w1" }), apply: async () => { throw new Error("apply must not run"); } });
  const res = await ship({ apiBase: "b", adminToken: "A", ships: [{ id: "w1", meta: {} }] });
  assert.equal(res.failed, 1);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].patch.stage, "error");
  assert.match(patches[0].patch.meta.run.error, /no manifest/);
});
