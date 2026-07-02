// Self-healing for the launchd worker. Observed failure mode (2026-07-02): after a
// sleep/wake cycle, EVERY launchd-spawned tick fails its first network call with
// "fetch failed" (fresh process each tick, same code works interactively) until the
// launchd JOB is bootout/bootstrap'd — a macOS background-agent network wedge. The
// worker went dark for ~4 hours before a human noticed. This module makes the tick
// itself detect the pattern and re-launch its own job.
//
// Pure decision logic here (TDD'd); the poller wires it to disk + launchctl.

// Threshold: ~8 minutes of consecutive dead ticks at the 90s cadence. Low enough to
// recover fast, high enough that one WiFi blip or a mid-sleep dark-wake tick or two
// never triggers a churny restart.
export const FAIL_THRESHOLD = 5;
// Never self-repair more often than this — if a repair doesn't cure the wedge
// (actual outage, backend down), looping bootouts would just thrash.
export const REPAIR_COOLDOWN_MS = 30 * 60 * 1000;

// state: { fails: number, lastRepairAt: number|null } (persisted by the poller)
export function onTickOutcome(state, { fetchOk, now = Date.now() } = {}) {
  const s = { fails: 0, lastRepairAt: null, ...(state || {}) };
  if (fetchOk) return { next: { ...s, fails: 0 }, repair: false };
  const fails = s.fails + 1;
  const cooledDown = !s.lastRepairAt || now - s.lastRepairAt >= REPAIR_COOLDOWN_MS;
  if (fails >= FAIL_THRESHOLD && cooledDown) {
    return { next: { fails: 0, lastRepairAt: now }, repair: true };
  }
  return { next: { ...s, fails }, repair: false };
}

// The exact remedy proven on 2026-07-02: relaunch the job in the gui domain. Runs
// DETACHED with a delay so it survives this tick's process exiting (the bootout
// kills our own job). Injected spawn for tests.
export function repairCommand({ uid, plistPath }) {
  return [
    "/bin/bash",
    [
      "-c",
      `sleep 3; /bin/launchctl bootout gui/${uid}/com.nynm.client-worker 2>/dev/null; sleep 2; /bin/launchctl bootstrap gui/${uid} '${plistPath}'`,
    ],
  ];
}
