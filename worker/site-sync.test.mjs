import { test } from "node:test";
import assert from "node:assert/strict";
import { syncSiteEvent } from "./site-sync.mjs";

const ENTRY = { id: "ap-southern-kitchen-2026-06-28", kind: "vendor-day", date: "Sun · Jun 28", isoDate: "2026-06-28T09:00:00-04:00", title: "AP Southern Kitchen", description: "", meta: "11A–4P · FOOD TRUCK" };

function fakeGit(over = {}) {
  const calls = [];
  const ok = (out = "") => async () => { return { ok: true, out }; };
  const g = {
    calls,
    branch: ok("main"),
    status: ok(""),
    pull: ok(""),
    add: async () => { calls.push("add"); return { ok: true, out: "" }; },
    commit: async () => { calls.push("commit"); return { ok: true, out: "" }; },
    push: async () => { calls.push("push"); return { ok: true, out: "" }; },
    ...over,
  };
  return g;
}
function fakeIO(initial = []) {
  let store = initial.slice();
  return { read: async () => store, write: async (a) => { store = a; }, get: () => store };
}

test("syncSiteEvent: clean repo on main, new entry → writes + commits + pushes", async () => {
  const git = fakeGit();
  const io = fakeIO([{ id: "jeep-jam", title: "Jeep Jam" }]);
  const res = await syncSiteEvent({ entry: ENTRY, git, io });
  assert.deepEqual(res, { ok: true, changed: true });
  assert.deepEqual(git.calls, ["add", "commit", "push"]);
  assert.equal(io.get().length, 2);
  assert.ok(io.get().some((e) => e.id === ENTRY.id));
});

test("syncSiteEvent: entry already present → idempotent no-op (no commit/push)", async () => {
  const git = fakeGit();
  const io = fakeIO([ENTRY]);
  const res = await syncSiteEvent({ entry: ENTRY, git, io });
  assert.equal(res.ok, true);
  assert.equal(res.changed, false);
  assert.deepEqual(git.calls, []); // never committed
});

test("syncSiteEvent: not on main → skipped, repo untouched", async () => {
  const git = fakeGit({ branch: async () => ({ ok: true, out: "some-worktree" }) });
  const io = fakeIO([]);
  const res = await syncSiteEvent({ entry: ENTRY, git, io });
  assert.equal(res.ok, false);
  assert.equal(res.skipped, true);
  assert.match(res.reason, /not on main/);
  assert.equal(io.get().length, 0);
});

test("syncSiteEvent: events.json dirty → skipped (never clobbers WIP)", async () => {
  const git = fakeGit({ status: async () => ({ ok: true, out: " M src/content/events.json" }) });
  const io = fakeIO([]);
  const res = await syncSiteEvent({ entry: ENTRY, git, io });
  assert.equal(res.skipped, true);
  assert.match(res.reason, /uncommitted local changes/);
  assert.deepEqual(git.calls, []);
});

test("syncSiteEvent: push fails → ok:false with reason", async () => {
  const git = fakeGit({ push: async () => ({ ok: false, err: "rejected: non-fast-forward" }) });
  const io = fakeIO([]);
  const res = await syncSiteEvent({ entry: ENTRY, git, io });
  assert.equal(res.ok, false);
  assert.match(res.reason, /push failed/);
});
