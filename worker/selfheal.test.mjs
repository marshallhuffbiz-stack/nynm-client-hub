import test from "node:test";
import assert from "node:assert/strict";
import { onTickOutcome, repairCommand, FAIL_THRESHOLD, REPAIR_COOLDOWN_MS } from "./selfheal.mjs";

test("success resets the failure streak", () => {
  const { next, repair } = onTickOutcome({ fails: 3, lastRepairAt: null }, { fetchOk: true });
  assert.equal(next.fails, 0);
  assert.equal(repair, false);
});

test("failures below threshold count up without repairing", () => {
  let state = { fails: 0, lastRepairAt: null };
  for (let i = 1; i < FAIL_THRESHOLD; i++) {
    const r = onTickOutcome(state, { fetchOk: false, now: 1000 + i });
    state = r.next;
    assert.equal(r.repair, false, `tick ${i} must not repair`);
    assert.equal(state.fails, i);
  }
});

test("hitting the threshold triggers exactly one repair and stamps cooldown", () => {
  const now = 5_000_000;
  const r = onTickOutcome({ fails: FAIL_THRESHOLD - 1, lastRepairAt: null }, { fetchOk: false, now });
  assert.equal(r.repair, true);
  assert.equal(r.next.lastRepairAt, now);
  assert.equal(r.next.fails, 0);
});

test("cooldown suppresses repeat repairs; expiry re-arms", () => {
  const t0 = 10_000_000;
  const inCooldown = onTickOutcome(
    { fails: FAIL_THRESHOLD - 1, lastRepairAt: t0 },
    { fetchOk: false, now: t0 + REPAIR_COOLDOWN_MS - 1 }
  );
  assert.equal(inCooldown.repair, false);
  const afterCooldown = onTickOutcome(
    { fails: FAIL_THRESHOLD - 1, lastRepairAt: t0 },
    { fetchOk: false, now: t0 + REPAIR_COOLDOWN_MS }
  );
  assert.equal(afterCooldown.repair, true);
});

test("missing/corrupt state is treated as fresh", () => {
  const r = onTickOutcome(null, { fetchOk: false, now: 1 });
  assert.equal(r.next.fails, 1);
  assert.equal(r.repair, false);
});

test("repairCommand relaunches the gui-domain job detached-safe", () => {
  const [bin, args] = repairCommand({ uid: 501, plistPath: "/Users/x/Library/LaunchAgents/com.nynm.client-worker.plist" });
  assert.equal(bin, "/bin/bash");
  const script = args[1];
  assert.match(script, /sleep 3;.*bootout gui\/501\/com\.nynm\.client-worker/);
  assert.match(script, /bootstrap gui\/501 '\/Users\/x\/Library\/LaunchAgents\/com\.nynm\.client-worker\.plist'/);
});
