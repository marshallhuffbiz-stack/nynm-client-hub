// Worker job detection — pure logic, TDD'd in jobs.test.mjs.

// Sort the live request list into the work the worker should do this tick.
export function detectJobs(requests = [], caps = { draft: 5, ship: 5 }) {
  const drafts = [];
  const ships = [];
  const newSubmits = [];
  for (const r of requests) {
    if (r.stage === "queued" || r.stage === "changes") drafts.push(r);
    else if (r.stage === "approved") ships.push(r);
    else if (r.stage === "submitted" && !(r.meta && r.meta.notified)) newSubmits.push(r);
  }
  // Ships are returned UNCAPPED: the poller splits them into social (auto-publish)
  // vs drain lanes and caps each lane independently, so a backlog of one type can't
  // starve the other. Drafts are still capped here (single lane).
  return { drafts: drafts.slice(0, caps.draft), ships, newSubmits };
}

// True if the daily digest is due: now is past `hour` today and we haven't sent
// a digest since today's `hour`.
export function shouldRunDigest(lastRunIso, now, hour) {
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);
  if (now < target) return false;
  if (!lastRunIso) return true;
  return new Date(lastRunIso) < target;
}

// A 'drafting' row is assumed to be owned by a live Claude drain. Worker ticks are
// serialized by worker/.lock, so any 'drafting' row still present at fetch time is
// from a PRIOR tick whose drain already exited (crashed, was killed, ran out of space
// mid-render, or — before the Retry fix — was pushed here by a manual Retry). Nothing
// else re-queues it, so without this it is stranded forever. The age threshold is a
// safety margin so a legitimately long-running drain is never mistaken for an orphan.
export function detectOrphans(requests = [], now = new Date(), maxAgeMs = 15 * 60 * 1000) {
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const orphans = [];
  for (const r of requests) {
    if (r.stage !== "drafting") continue;
    const updated = r.updatedAt ? Date.parse(r.updatedAt) : NaN;
    if (Number.isNaN(updated) || t - updated >= maxAgeMs) orphans.push(r);
  }
  return orphans;
}

// Decide what to do with each orphaned 'drafting' row: re-queue it (clearing any stale
// error so the Desk stops showing it), or — once it has been auto-recovered maxRequeues
// times — give up and surface a real error instead of re-spawning a drain every tick
// forever. Returns [{ id, patch }] for the caller to apply via apiUpdate.
export function planOrphanRecovery(orphans = [], maxRequeues = 3) {
  return orphans.map((r) => {
    const run = (r.meta && r.meta.run) || {};
    const tries = Number(run.requeues || 0);
    if (tries >= maxRequeues) {
      return {
        id: r.id,
        patch: { stage: "error", meta: { ...(r.meta || {}), run: { ...run, error: `Auto-recovery gave up after ${tries} attempts — please resend this request.` } } },
      };
    }
    return {
      id: r.id,
      patch: { stage: "queued", draft: null, meta: { ...(r.meta || {}), run: { ...run, requeues: tries + 1, error: "" } } },
    };
  });
}
